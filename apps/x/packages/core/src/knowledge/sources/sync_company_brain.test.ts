// believe: tests for the Company Brain pull source (pattern: sync_slack.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KnowledgeSourceConfig } from './types.js';
import type { BrainTransport, Episode } from '../../brain/transport.js';

// WorkDir is resolved when config.js loads, so the env override must be in
// place before sync_company_brain.js (which imports it) is loaded — hence
// the dynamic import in beforeAll.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sync-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;

const sourceA: KnowledgeSourceConfig = {
    id: 'company-brain',
    provider: 'company_brain',
    enabled: true,
    artifactDir: 'knowledge_sources/company_brain',
    syncMode: 'poll',
    intervalMs: 5 * 60 * 1000,
    scopes: [],
};

vi.mock('./repo.js', () => ({
    knowledgeSourcesRepo: {
        listEnabledSources: vi.fn(() => [sourceA]),
        getConfig: vi.fn(() => ({ sources: [sourceA] })),
    },
}));

vi.mock('../../services/service_logger.js', () => ({
    serviceLogger: {
        startRun: vi.fn(async () => ({ service: 'company_brain', runId: 'test-run', startedAt: Date.now() })),
        log: vi.fn(async () => { }),
    },
}));

vi.mock('../../events/producer.js', () => ({
    createEvent: vi.fn(async () => { }),
}));

type SyncModule = typeof import('./sync_company_brain.js');
let sync: SyncModule;
let BrainTransportError: typeof import('../../brain/transport.js').BrainTransportError;

const stateFile = path.join(tmpWorkDir, 'company_brain_sync_state.json');
const artifactRoot = path.join(tmpWorkDir, 'knowledge_sources', 'company_brain');

function readState() {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

/** Rewind a source's lastSyncAt so it counts as due again. */
function rewindSource(sourceId: string, ms: number) {
    const state = readState();
    state.sources[sourceId].lastSyncAt = new Date(Date.now() - ms).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf-8');
}

// Fixtures from the contract (BELIEVE-FORK.md): real-shaped episode rows.
const omiEpisode: Episode = {
    id: 'ep-omi-1',
    source: 'omi',
    external_id: 'omi:conv-123',
    actors: ['Jorge', 'Dani'],
    summary: 'Sync semanal de paid: decidimos duplicar presupuesto en Meta.',
    decision_summary: 'Duplicar presupuesto Meta esta semana.',
    transcript_ref: 'Jorge: hola equipo...\nDani: dale, arrancamos.',
    client_id: null,
    channel: 'meeting',
    metadata: { device: 'omi-necklace', duration_s: 1820 },
    created_at: '2026-07-01T15:00:00.000Z',
};
const mattermostEpisode: Episode = {
    id: 'ep-mm-2',
    source: 'mattermost',
    external_id: 'mm:post-987',
    actors: ['Sebas'],
    summary: 'Reporte de campañas: CPA bajó 12% tras el cambio de creativos.',
    channel: 'paid-media',
    metadata: { team: 'believe' },
    created_at: '2026-07-02T10:30:00.000Z',
};
const desktopEcho: Episode = {
    id: 'ep-desktop-3',
    source: 'manual',
    external_id: 'desktop:notes/idea.md',
    actors: ['Jorge'],
    summary: 'Nota local empujada desde este mismo desktop.',
    channel: 'desktop',
    metadata: {},
    created_at: '2026-07-03T09:00:00.000Z',
};

class FakeTransport implements BrainTransport {
    calls: { since?: string; offset?: number; limit?: number }[] = [];
    /** pages[i] returned for the i-th queryEpisodes call. */
    constructor(private pages: Episode[][] = [[]], private error?: Error) { }
    async queryEpisodes(opts: { since?: string; offset?: number; limit?: number }): Promise<Episode[]> {
        this.calls.push(opts);
        if (this.error) throw this.error;
        return this.pages[Math.min(this.calls.length - 1, this.pages.length - 1)] ?? [];
    }
    async ingestEpisodes(): Promise<never> {
        throw new Error('not used in pull tests');
    }
}

beforeAll(async () => {
    sync = await import('./sync_company_brain.js');
    ({ BrainTransportError } = await import('../../brain/transport.js'));
});

beforeEach(() => {
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('syncCompanyBrainKnowledgeSources artifacts', () => {
    it('writes one frontmattered .md per episode with the slack-pattern frontmatter plus brain_origin', async () => {
        const transport = new FakeTransport([[omiEpisode, mattermostEpisode]]);
        const files = await sync.syncCompanyBrainKnowledgeSources(transport);
        expect(files).toHaveLength(2);

        const omiPath = path.join(artifactRoot, 'omi', 'omi_conv-123.md');
        expect(files).toContain(omiPath);
        const content = fs.readFileSync(omiPath, 'utf-8');
        expect(content).toMatch(/^---\n/);
        expect(content).toContain('source: company_brain');
        expect(content).toContain('source_id: company-brain');
        expect(content).toContain('external_id: "brain:ep-omi-1"');
        expect(content).toContain('version: "2026-07-01T15:00:00.000Z"');
        expect(content).toContain('occurred_at: "2026-07-01T15:00:00.000Z"');
        expect(content).toContain('brain_origin: central');
        // Body is human-readable: title from summary, actors, channel, transcript, metadata.
        expect(content).toContain('# Sync semanal de paid: decidimos duplicar presupuesto en Meta.');
        expect(content).toContain('**Actors:** Jorge, Dani');
        expect(content).toContain('**Channel:** meeting');
        expect(content).toContain('## Decisions');
        expect(content).toContain('Duplicar presupuesto Meta esta semana.');
        expect(content).toContain('## Transcript');
        expect(content).toContain('**device:** omi-necklace');

        const mmPath = path.join(artifactRoot, 'mattermost', 'mm_post-987.md');
        expect(fs.existsSync(mmPath)).toBe(true);
    });

    it('is idempotent: a second run does not rewrite unchanged artifacts', async () => {
        const first = await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode]]));
        expect(first).toHaveLength(1);
        const mtime = fs.statSync(first[0]).mtimeMs;

        rewindSource('company-brain', 60 * 60 * 1000);
        const second = await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode]]));
        expect(second).toHaveLength(0);
        expect(fs.statSync(first[0]).mtimeMs).toBe(mtime);
    });

    it('filters desktop: echoes but still advances the watermark past them', async () => {
        const files = await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode, desktopEcho]]));
        expect(files).toHaveLength(1);
        expect(fs.existsSync(path.join(artifactRoot, 'manual'))).toBe(false);
        expect(readState().sources['company-brain'].lastCreatedAt).toBe('2026-07-03T09:00:00.000Z');
    });
});

describe('watermark and pagination', () => {
    it('advances the watermark and re-queries with a 24h overlap', async () => {
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode, mattermostEpisode]]));
        expect(readState().sources['company-brain'].lastCreatedAt).toBe('2026-07-02T10:30:00.000Z');

        rewindSource('company-brain', 60 * 60 * 1000);
        const transport = new FakeTransport([[]]);
        await sync.syncCompanyBrainKnowledgeSources(transport);
        // since = watermark - 24h
        expect(transport.calls[0].since).toBe('2026-07-01T10:30:00.000Z');
    });

    it('first run queries without since', async () => {
        const transport = new FakeTransport([[]]);
        await sync.syncCompanyBrainKnowledgeSources(transport);
        expect(transport.calls[0].since).toBeUndefined();
    });

    it('paginates by offset until a short page and dedups repeated ids across pages', async () => {
        const page1: Episode[] = Array.from({ length: 200 }, (_, i) => ({
            ...omiEpisode,
            id: `ep-${i}`,
            external_id: `omi:conv-${i}`,
        }));
        // Second page repeats one id from page 1 plus a new one.
        const page2: Episode[] = [{ ...omiEpisode, id: 'ep-0', external_id: 'omi:conv-0' }, mattermostEpisode];
        const transport = new FakeTransport([page1, page2]);
        const files = await sync.syncCompanyBrainKnowledgeSources(transport);

        expect(transport.calls).toHaveLength(2);
        expect(transport.calls[0].offset).toBe(0);
        expect(transport.calls[1].offset).toBe(200);
        // 200 unique from page 1 + 1 new from page 2; the duplicate is not rewritten.
        expect(files).toHaveLength(201);
    });

    it('dedups by id inside the overlap window across runs', async () => {
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode]]));
        rewindSource('company-brain', 60 * 60 * 1000);
        // Same id comes back (overlap window); modified summary must NOT be
        // reprocessed because the id was already seen.
        const modified = { ...omiEpisode, summary: 'changed' };
        const files = await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[modified]]));
        expect(files).toHaveLength(0);
    });
});

describe('status, errors and backoff', () => {
    it('records ok status and lastSyncAt', async () => {
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[]]));
        const state = readState();
        expect(state.sources['company-brain'].lastStatus).toBe('ok');
        expect(Date.parse(state.sources['company-brain'].lastSyncAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('records the transport error kind and grows backoff on rate limits, resetting on success', async () => {
        const rateLimited = () => new FakeTransport([[]], new BrainTransportError('rate_limited', 'slow down', 429));
        await sync.syncCompanyBrainKnowledgeSources(rateLimited());
        let s = readState().sources['company-brain'];
        expect(s.lastStatus).toBe('error');
        expect(s.lastError.kind).toBe('rate_limited');
        expect(s.backoffMultiplier).toBe(2);

        rewindSource('company-brain', 60 * 60 * 1000);
        await sync.syncCompanyBrainKnowledgeSources(rateLimited());
        expect(readState().sources['company-brain'].backoffMultiplier).toBe(4);

        rewindSource('company-brain', 60 * 60 * 1000);
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[]]));
        s = readState().sources['company-brain'];
        expect(s.lastStatus).toBe('ok');
        expect(s.backoffMultiplier).toBeUndefined();
    });

    it('does not lose the watermark when a later run fails', async () => {
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode]]));
        rewindSource('company-brain', 60 * 60 * 1000);
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[]], new BrainTransportError('server_error', 'boom', 500)));
        expect(readState().sources['company-brain'].lastCreatedAt).toBe('2026-07-01T15:00:00.000Z');
    });

    it('skips a source that is not yet due', async () => {
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[]]));
        const transport = new FakeTransport([[]]);
        await sync.syncCompanyBrainKnowledgeSources(transport);
        expect(transport.calls).toHaveLength(0);
    });
});

describe('effectiveIntervalMs', () => {
    it('multiplies the base interval by the backoff and caps at 30 minutes', () => {
        expect(sync.effectiveIntervalMs(sourceA, undefined)).toBe(5 * 60 * 1000);
        expect(sync.effectiveIntervalMs(sourceA, { backoffMultiplier: 4 })).toBe(20 * 60 * 1000);
        expect(sync.effectiveIntervalMs(sourceA, { backoffMultiplier: 1024 })).toBe(30 * 60 * 1000);
    });
});

describe('getCompanyBrainSyncStatus', () => {
    it('reports per-source status with watermark and nextDueAt', async () => {
        await sync.syncCompanyBrainKnowledgeSources(new FakeTransport([[omiEpisode]]));
        const statuses = sync.getCompanyBrainSyncStatus();
        const a = statuses.find(s => s.id === 'company-brain');
        expect(a).toMatchObject({ enabled: true, lastStatus: 'ok', lastCreatedAt: '2026-07-01T15:00:00.000Z' });
        expect(Date.parse(a!.nextDueAt!)).toBeCloseTo(Date.parse(a!.lastSyncAt!) + 5 * 60 * 1000, -3);
    });
});
