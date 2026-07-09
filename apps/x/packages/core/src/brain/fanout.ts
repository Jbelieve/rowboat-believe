// believe: episode fanout producer (module 3 of BELIEVE-FORK.md).
// Scans WorkDir/knowledge/**/*.md for new/changed notes (mtime+hash state in
// brain_fanout_state.json, pattern: knowledge/graph_state.ts) and pushes them
// to the Company Brain as `manual` episodes via the injected transport, in
// chunks of FANOUT_CHUNK_SIZE with state persisted after each successful
// chunk. Fail-soft: transient failures leave unpushed notes unmarked (they
// retry next tick); deterministic 4xx rejections are bisected to the poison
// note, which is skipped after MAX_NOTE_FAILURES. Notes whose frontmatter
// carries `brain_origin: central` are never pushed (echo guard for pulled
// artifacts).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WorkDir } from '../config/config.js';
import { getDeviceId } from '../config/company_brain_config.js';
import { BrainTransportError } from './transport.js';
import type { BrainTransport, EpisodeInput } from './transport.js';

const STATE_FILE = path.join(WorkDir, 'brain_fanout_state.json');
const KNOWLEDGE_DIR = path.join(WorkDir, 'knowledge');
/** transcript_ref hard cap from the ingest contract. */
const MAX_TRANSCRIPT_CHARS = 8000;
/** Episodes per ingest call; state is persisted after EACH successful chunk. */
export const FANOUT_CHUNK_SIZE = 25;
/** Deterministic-4xx failures before a poison note is skipped for good. */
export const MAX_NOTE_FAILURES = 3;

type FanoutFileState = {
    mtime: string;
    hash: string;
    lastPushedAt?: string;
    /** Consecutive deterministic-4xx failures for this exact content hash. */
    failCount?: number;
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
                // A note mid-retry (0 < failCount < max) must be rescanned even
                // though its mtime/hash are recorded; at max failures it is
                // poisoned and skipped until its content changes.
                const retrying = previous?.failCount !== undefined && previous.failCount < MAX_NOTE_FAILURES;
                if (previous && previous.mtime === mtime && !retrying) continue;

                const body = fs.readFileSync(fullPath, 'utf-8');
                const hash = hashContent(body);
                if (previous && previous.hash === hash && !retrying) continue;

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

    private deviceId?: string;

    /** Per-device namespace for external_ids, lazy-loaded from the config. */
    private ownDeviceId(): string {
        this.deviceId ??= getDeviceId();
        return this.deviceId;
    }

    /** Normalize one note into the ingest contract's episode shape. */
    buildEpisode(note: FanoutNote): EpisodeInput {
        const content = stripFrontmatter(note.body).trim();
        return {
            source: 'manual',
            // deviceId namespace: the pull echo filter only discards THIS
            // device's ids, so other desktops' notes still materialize.
            external_id: `desktop:${this.ownDeviceId()}:${note.relPath.split(path.sep).join('/')}`,
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

    /** Persist success state for a batch of notes (clears any failCount). */
    private markPushed(notes: FanoutNote[]): void {
        if (notes.length === 0) return;
        const state = loadState(this.stateFile);
        const now = new Date().toISOString();
        for (const note of notes) {
            state.files[note.relPath] = { mtime: note.mtime, hash: note.hash, lastPushedAt: now };
        }
        saveState(this.stateFile, state);
    }

    /** Record a deterministic-4xx failure for an isolated poison note. */
    private recordFailure(note: FanoutNote): void {
        const state = loadState(this.stateFile);
        const previous = state.files[note.relPath];
        // Counting restarts when the content changed since the last failure.
        const failCount = (previous?.hash === note.hash ? previous.failCount ?? 0 : 0) + 1;
        state.files[note.relPath] = { mtime: note.mtime, hash: note.hash, failCount };
        saveState(this.stateFile, state);
        console.error(`[BrainFanout] Note ${note.relPath} rejected by the brain (failure ${failCount}/${MAX_NOTE_FAILURES})`);
    }

    /**
     * Push one chunk. On a deterministic 4xx (bad_request) bisect until the
     * poison note is isolated, record its failCount and keep going with the
     * rest. Transient errors (network/5xx/429/auth) rethrow so the run stops
     * and retries next tick from the last persisted chunk.
     */
    private async pushChunk(transport: BrainTransport, chunk: FanoutNote[]): Promise<number> {
        try {
            await transport.ingestEpisodes(chunk.map(note => this.buildEpisode(note)));
            this.markPushed(chunk);
            return chunk.length;
        } catch (error) {
            const deterministic = error instanceof BrainTransportError && error.kind === 'bad_request';
            if (!deterministic) throw error;
            if (chunk.length === 1) {
                this.recordFailure(chunk[0]);
                return 0;
            }
            const mid = Math.ceil(chunk.length / 2);
            const left = await this.pushChunk(transport, chunk.slice(0, mid));
            const right = await this.pushChunk(transport, chunk.slice(mid));
            return left + right;
        }
    }

    /**
     * Push all new/changed notes in chunks of FANOUT_CHUNK_SIZE, persisting
     * state after EACH successful chunk. Fail-soft: a transient transport
     * failure leaves the remaining notes unmarked (they retry next tick) and
     * rethrows so the caller can record the error; a deterministic 4xx is
     * bisected to the poison note, which accrues failCount and is skipped for
     * good after MAX_NOTE_FAILURES without blocking the rest.
     */
    async emit(transport: BrainTransport): Promise<FanoutEmitResult> {
        const notes = this.scanKnowledgeNotes();
        if (notes.length === 0) return { pushed: 0, scanned: 0 };

        // Excluded (centrally-owned) notes are never sent — mark them up front.
        this.markPushed(notes.filter(note => note.excluded));

        const toPush = notes.filter(note => !note.excluded);
        let pushed = 0;
        for (let i = 0; i < toPush.length; i += FANOUT_CHUNK_SIZE) {
            pushed += await this.pushChunk(transport, toPush.slice(i, i + FANOUT_CHUNK_SIZE));
        }

        return { pushed, scanned: notes.length };
    }
}
