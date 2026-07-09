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

type FanoutModule = typeof import('./fanout.js');
let EpisodeFanoutProducer: FanoutModule['EpisodeFanoutProducer'];

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
});

beforeEach(() => {
    fs.rmSync(knowledgeDir, { recursive: true, force: true });
    fs.rmSync(stateFile, { force: true });
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
            external_id: 'desktop:Ideas/launch.md',
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
        expect(transport.batches[0].map(e => e.external_id)).toEqual(['desktop:mine.md']);
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
        expect(retry.batches[0][0].external_id).toBe('desktop:a.md');
    });

    it('re-pushes a note when its content changes', async () => {
        const abs = writeNote('a.md', '# A\n\nv1\n');
        const producer = new EpisodeFanoutProducer();
        await producer.emit(new FakeTransport());

        fs.writeFileSync(abs, '# A\n\nv2\n', 'utf-8');
        const transport = new FakeTransport();
        const result = await producer.emit(transport);
        expect(result.pushed).toBe(1);
        expect(transport.batches[0][0].transcript_ref).toContain('v2');
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
