// believe: episode fanout producer (module 3 of BELIEVE-FORK.md).
// Scans WorkDir/knowledge/**/*.md for new/changed notes (mtime+hash state in
// brain_fanout_state.json, pattern: knowledge/graph_state.ts) and pushes them
// to the Company Brain as `manual` episodes via the injected transport.
// Fail-soft: if the ingest call fails, NO note is marked processed — they all
// retry on the next tick. Notes whose frontmatter carries
// `brain_origin: central` are never pushed (echo guard for pulled artifacts).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WorkDir } from '../config/config.js';
import type { BrainTransport, EpisodeInput } from './transport.js';

const STATE_FILE = path.join(WorkDir, 'brain_fanout_state.json');
const KNOWLEDGE_DIR = path.join(WorkDir, 'knowledge');
/** transcript_ref hard cap from the ingest contract. */
const MAX_TRANSCRIPT_CHARS = 8000;

type FanoutFileState = {
    mtime: string;
    hash: string;
    lastPushedAt: string;
};

type FanoutState = {
    files: Record<string, FanoutFileState>; // relPath -> state
};

export type FanoutNote = {
    /** Path relative to WorkDir/knowledge, used as the external_id suffix. */
    relPath: string;
    absPath: string;
    mtime: string;
    hash: string;
    /** True when the note is centrally-owned (brain_origin: central). */
    excluded: boolean;
    body: string;
};

export type FanoutEmitResult = {
    /** Episodes actually sent to the brain this pass. */
    pushed: number;
    /** Notes scanned as changed (pushed + excluded). */
    scanned: number;
};

function loadState(stateFile: string): FanoutState {
    try {
        if (fs.existsSync(stateFile)) {
            const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Partial<FanoutState>;
            return { files: {}, ...parsed };
        }
    } catch (error) {
        console.error('[BrainFanout] Failed to load state:', error);
    }
    return { files: {} };
}

function saveState(stateFile: string, state: FanoutState): void {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/** Extract the raw frontmatter block (without delimiters), or null. */
function frontmatterBlock(body: string): string | null {
    if (!body.startsWith('---\n')) return null;
    const end = body.indexOf('\n---', 4);
    if (end === -1) return null;
    return body.slice(4, end);
}

function hasCentralOrigin(body: string): boolean {
    const block = frontmatterBlock(body);
    if (!block) return false;
    return /^brain_origin:\s*central\s*$/m.test(block);
}

/** Note body without the frontmatter block. */
function stripFrontmatter(body: string): string {
    const block = frontmatterBlock(body);
    if (block === null) return body;
    const after = body.indexOf('\n---', 4) + 4;
    const newline = body.indexOf('\n', after);
    return newline === -1 ? '' : body.slice(newline + 1);
}

function extractWikilinks(body: string): string[] {
    const links = new Set<string>();
    for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        const target = match[1].trim();
        if (target) links.add(target);
    }
    return Array.from(links);
}

/** Title = first markdown heading, else first non-empty line, else relPath. */
function extractSummary(content: string, relPath: string): string {
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const heading = trimmed.match(/^#+\s+(.*)$/);
        return (heading ? heading[1] : trimmed).slice(0, 500);
    }
    return relPath;
}

export class EpisodeFanoutProducer {
    constructor(
        private readonly knowledgeDir: string = KNOWLEDGE_DIR,
        private readonly stateFile: string = STATE_FILE,
    ) { }

    /** New/changed .md notes under the knowledge dir (mtime fast-path, hash confirm). */
    scanKnowledgeNotes(): FanoutNote[] {
        if (!fs.existsSync(this.knowledgeDir)) return [];
        const state = loadState(this.stateFile);
        const notes: FanoutNote[] = [];

        const traverse = (dir: string) => {
            for (const entry of fs.readdirSync(dir)) {
                const fullPath = path.join(dir, entry);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    traverse(fullPath);
                    continue;
                }
                if (!stat.isFile() || !entry.endsWith('.md')) continue;

                const relPath = path.relative(this.knowledgeDir, fullPath);
                const previous = state.files[relPath];
                const mtime = stat.mtime.toISOString();
                if (previous && previous.mtime === mtime) continue;

                const body = fs.readFileSync(fullPath, 'utf-8');
                const hash = hashContent(body);
                if (previous && previous.hash === hash) continue;

                notes.push({
                    relPath,
                    absPath: fullPath,
                    mtime,
                    hash,
                    excluded: hasCentralOrigin(body),
                    body,
                });
            }
        };

        traverse(this.knowledgeDir);
        return notes;
    }

    /** Normalize one note into the ingest contract's episode shape. */
    buildEpisode(note: FanoutNote): EpisodeInput {
        const content = stripFrontmatter(note.body).trim();
        return {
            source: 'manual',
            external_id: `desktop:${note.relPath.split(path.sep).join('/')}`,
            actors: [],
            summary: extractSummary(content, note.relPath),
            transcript_ref: content.slice(0, MAX_TRANSCRIPT_CHARS),
            channel: 'desktop',
            metadata: {
                path: note.relPath.split(path.sep).join('/'),
                wikilinks: extractWikilinks(content),
            },
        };
    }

    /**
     * Push all new/changed notes as one ingest batch. Fail-soft: a transport
     * failure marks NOTHING as processed (everything retries next tick) and
     * rethrows so the caller can record the error. On success every scanned
     * note is marked — including excluded ones and server-side `skipped` rows
     * (idempotent upsert already has them).
     */
    async emit(transport: BrainTransport): Promise<FanoutEmitResult> {
        const notes = this.scanKnowledgeNotes();
        if (notes.length === 0) return { pushed: 0, scanned: 0 };

        const toPush = notes.filter(note => !note.excluded);
        if (toPush.length > 0) {
            await transport.ingestEpisodes(toPush.map(note => this.buildEpisode(note)));
        }

        // Only reached on success (or when everything was excluded).
        const state = loadState(this.stateFile);
        const now = new Date().toISOString();
        for (const note of notes) {
            state.files[note.relPath] = { mtime: note.mtime, hash: note.hash, lastPushedAt: now };
        }
        saveState(this.stateFile, state);

        return { pushed: toPush.length, scanned: notes.length };
    }
}
