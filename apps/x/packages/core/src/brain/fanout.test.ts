// believe: tests for the episode fanout producer (pattern: sync_slack.test.ts —
// ROWBOAT_WORKDIR tmpdir set BEFORE the dynamic import, zero real network).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrainTransport, EpisodeInput, IngestResult } from './transport.js';

// WorkDir is resolved when config.js loads, so the env override must be in
// place before fanout.js (which imports it) is loaded.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-fanout-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;

const knowledgeDir = path.join(tmpWorkDir, 'knowledge');
const stateFile = path.join(tmpWorkDir, 'brain_fanout_state.json');
const configFile = path.join(tmpWorkDir, 'config', 'company_brain.json');
// Fixed deviceId so external_id expectations are deterministic.
const DEVICE_ID = 'deadbeef';

type FanoutModule = typeof import('./fanout.js');
let EpisodeFanoutProducer: FanoutModule['EpisodeFanoutProducer'];
let BrainTransportError: typeof import('./transport.js').BrainTransportError;

class FakeTransport implements BrainTransport {
    batches: EpisodeInput[][] = [];
    constructor(private error?: Error) { }
    async queryEpisodes(): Promise<never> {
        throw new Error('not used in fanout tests');
    }
    async ingestEpisodes(eps: EpisodeInput[]): Promise<IngestResult> {
        this.batches.push(eps);
        if (this.error) throw this.error;
        return { ok: true, ingested: { episodes: eps.length }, skipped: {} };
    }
}

function writeNote(relPath: string, content: string): string {
    const abs = path.join(knowledgeDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
    return abs;
}

beforeAll(async () => {
    ({ EpisodeFanoutProducer } = await import('./fanout.js'));
    ({ BrainTransportError } = await import('./transport.js'));
});

beforeEach(() => {
    fs.rmSync(knowledgeDir, { recursive: true, force: true });
    fs.rmSync(stateFile, { force: true });
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ deviceId: DEVICE_ID }), 'utf-8');
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('buildEpisode', () => {
    it('normalizes a note into the ingest contract shape', async () => {
        writeNote('Ideas/launch.md', '# Plan de lanzamiento\n\nHablar con [[Dani]] y revisar [[Meta Ads|los ads]].\n');
        const producer = new EpisodeFanoutProducer();
        const notes = producer.scanKnowledgeNotes();
        expect(notes).toHaveLength(1);

        const episode = producer.buildEpisode(notes[0]);
        expect(episode).toMatchObject({
            source: 'manual',
            external_id: `desktop:${DEVICE_ID}:Ideas/launch.md`,
            actors: [],
            summary: 'Plan de lanzamiento',
            channel: 'desktop',
            metadata: { path: 'Ideas/launch.md', wikilinks: ['Dani', 'Meta Ads'] },
        });
        expect(episode.transcript_ref).toContain('Hablar con [[Dani]]');
    });

    it('caps transcript_ref at 8000 chars', () => {
        writeNote('big.md', `# Big note\n\n${'x'.repeat(20_000)}`);
        const producer = new EpisodeFanoutProducer();
        const episode = producer.buildEpisode(producer.scanKnowledgeNotes()[0]);
        expect(episode.transcript_ref!.length).toBe(8000);
    });

    it('strips frontmatter from the body and falls back to the first line as summary', () => {
        writeNote('meta.md', '---\ntags: [a, b]\n---\nUna nota sin heading.\nSegunda línea.\n');
        const producer = new EpisodeFanoutProducer();
        const episode = producer.buildEpisode(producer.scanKnowledgeNotes()[0]);
        expect(episode.summary).toBe('Una nota sin heading.');
        expect(episode.transcript_ref).not.toContain('tags:');
    });
});

describe('scan + exclusion', () => {
    it('marks notes with brain_origin: central as excluded and never pushes them', async () => {
        writeNote('mine.md', '# Mía\n\nContenido local.\n');
        writeNote('pulled.md', '---\nsource: company_brain\nbrain_origin: central\n---\n# Del brain\n');
        const producer = new EpisodeFanoutProducer();
        const transport = new FakeTransport();

        const result = await producer.emit(transport);
        expect(result).toEqual({ pushed: 1, scanned: 2 });
        expect(transport.batches).toHaveLength(1);
        expect(transport.batches[0].map(e => e.external_id)).toEqual([`desktop:${DEVICE_ID}:mine.md`]);
    });

    it('scans nothing when the knowledge dir does not exist', () => {
        const producer = new EpisodeFanoutProducer();
        expect(producer.scanKnowledgeNotes()).toEqual([]);
    });
});

describe('emit state advancement', () => {
    it('advances state on success (including excluded notes) so a second emit pushes nothing', async () => {
        writeNote('a.md', '# A\n\ncuerpo\n');
        writeNote('central.md', '---\nbrain_origin: central\n---\n# C\n');
        const producer = new EpisodeFanoutProducer();

        await producer.emit(new FakeTransport());
        const second = await producer.emit(new FakeTransport());
        expect(second).toEqual({ pushed: 0, scanned: 0 });

        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(Object.keys(state.files).sort()).toEqual(['a.md', 'central.md']);
    });

    it('does NOT advance state when the transport fails — notes retry next tick', async () => {
        writeNote('a.md', '# A\n\ncuerpo\n');
        const producer = new EpisodeFanoutProducer();

        await expect(producer.emit(new FakeTransport(new Error('network down')))).rejects.toThrow('network down');
        expect(fs.existsSync(stateFile)).toBe(false);

        // Retry succeeds and pushes the same note.
        const retry = new FakeTransport();
        const result = await producer.emit(retry);
        expect(result.pushed).toBe(1);
        expect(retry.batches[0][0].external_id).toBe(`desktop:${DEVICE_ID}:a.md`);
    });

    it('re-pushes a note when its content changes', async () => {
        const abs = writeNote('a.md', '# A\n\nv1\n');
        const producer = new EpisodeFanoutProducer();
        await producer.emit(new FakeTransport());

        fs.writeFileSync(abs, '# A\n\nv2\n', 'utf-8');
        // The mtime fast-path has ms resolution; force a distinct mtime so the
        // rewrite is detected even when it lands in the same millisecond.
        const bumped = new Date(Date.now() + 1000);
        fs.utimesSync(abs, bumped, bumped);
        const transport = new FakeTransport();
        const result = await producer.emit(transport);
        expect(result.pushed).toBe(1);
        expect(transport.batches[0][0].transcript_ref).toContain('v2');
    });

    it('emits in chunks of 25 and persists state after each successful chunk', async () => {
        for (let i = 0; i < 30; i++) {
            writeNote(`note-${String(i).padStart(2, '0')}.md`, `# Note ${i}\n\ncuerpo ${i}\n`);
        }
        const transport = new FakeTransport();
        const result = await new EpisodeFanoutProducer().emit(transport);
        expect(result).toEqual({ pushed: 30, scanned: 30 });
        expect(transport.batches.map(b => b.length)).toEqual([25, 5]);
    });

    it('keeps the state of already-pushed chunks when a later chunk fails transiently', async () => {
        for (let i = 0; i < 30; i++) {
            writeNote(`note-${String(i).padStart(2, '0')}.md`, `# Note ${i}\n\ncuerpo ${i}\n`);
        }
        // First chunk succeeds, second dies with a network error.
        let call = 0;
        const transport: BrainTransport = {
            queryEpisodes: async () => { throw new Error('unused'); },
            ingestEpisodes: async (eps: EpisodeInput[]) => {
                call++;
                if (call === 2) throw new BrainTransportError('network', 'connection reset');
                return { ok: true, ingested: { episodes: eps.length }, skipped: {} };
            },
        };
        await expect(new EpisodeFanoutProducer().emit(transport)).rejects.toThrow('connection reset');
        // The 25 notes of the first chunk are marked; the remaining 5 retry.
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(Object.keys(state.files)).toHaveLength(25);

        const retry = new FakeTransport();
        const result = await new EpisodeFanoutProducer().emit(retry);
        expect(result.pushed).toBe(5);
    });

    it('bisects a deterministic 4xx to the poison note and skips it after 3 failures without blocking the rest', async () => {
        writeNote('good-1.md', '# G1\n\nok\n');
        writeNote('poison.md', '# P\n\nveneno\n');
        writeNote('good-2.md', '# G2\n\nok\n');
        const poisonId = `desktop:${DEVICE_ID}:poison.md`;
        const rejectingTransport = (): BrainTransport & { accepted: string[] } => {
            const accepted: string[] = [];
            return {
                accepted,
                queryEpisodes: async () => { throw new Error('unused'); },
                ingestEpisodes: async (eps: EpisodeInput[]) => {
                    if (eps.some(e => e.external_id === poisonId)) {
                        throw new BrainTransportError('bad_request', 'invalid episode', 400);
                    }
                    accepted.push(...eps.map(e => e.external_id));
                    return { ok: true, ingested: { episodes: eps.length }, skipped: {} };
                },
            };
        };

        // Run 1: poison isolated (failCount 1), the other two notes land.
        const t1 = rejectingTransport();
        const r1 = await new EpisodeFanoutProducer().emit(t1);
        expect(r1.pushed).toBe(2);
        expect(t1.accepted.sort()).toEqual([`desktop:${DEVICE_ID}:good-1.md`, `desktop:${DEVICE_ID}:good-2.md`]);
        let state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state.files['poison.md'].failCount).toBe(1);

        // Runs 2 and 3: only the poison note retries, accruing failures.
        await new EpisodeFanoutProducer().emit(rejectingTransport());
        const r3 = await new EpisodeFanoutProducer().emit(rejectingTransport());
        expect(r3).toEqual({ pushed: 0, scanned: 1 });
        state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state.files['poison.md'].failCount).toBe(3);

        // Run 4: poisoned note is skipped entirely.
        const t4 = rejectingTransport();
        const r4 = await new EpisodeFanoutProducer().emit(t4);
        expect(r4).toEqual({ pushed: 0, scanned: 0 });

        // Editing the note resets the count and retries it.
        const abs = path.join(knowledgeDir, 'poison.md');
        fs.writeFileSync(abs, '# P\n\narreglada\n', 'utf-8');
        const bumped = new Date(Date.now() + 1000);
        fs.utimesSync(abs, bumped, bumped);
        const t5 = rejectingTransport();
        const r5 = await new EpisodeFanoutProducer().emit(t5);
        expect(r5).toEqual({ pushed: 0, scanned: 1 });
        state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state.files['poison.md'].failCount).toBe(1);
    });

    it('does not re-push when mtime changes but content is identical', async () => {
        const abs = writeNote('a.md', '# A\n\nmismo\n');
        const producer = new EpisodeFanoutProducer();
        await producer.emit(new FakeTransport());

        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(abs, future, future);
        const result = await producer.emit(new FakeTransport());
        expect(result).toEqual({ pushed: 0, scanned: 0 });
    });
});
