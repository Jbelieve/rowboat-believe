// believe: tests for the Be Chat (Mattermost) connector (pattern: sync_slack.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KnowledgeSourceConfig } from './types.js';
import type { MattermostPost, MattermostPostsResponse } from './sync_mattermost.js';

// WorkDir is resolved when config.js loads, so the env override must be in
// place before sync_mattermost.js (which imports it) is loaded — hence the
// dynamic import in beforeAll.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mattermost-sync-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;

const sourceA: KnowledgeSourceConfig = {
    id: 'be-chat',
    provider: 'mattermost',
    enabled: true,
    artifactDir: 'knowledge_sources/mattermost',
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
        startRun: vi.fn(async () => ({ service: 'mattermost', runId: 'test-run', startedAt: Date.now() })),
        log: vi.fn(async () => { }),
    },
}));

vi.mock('../../events/producer.js', () => ({
    createEvent: vi.fn(async () => { }),
}));

type SyncModule = typeof import('./sync_mattermost.js');
let sync: SyncModule;

const MM_URL = 'https://chat.believe-global.com';
const CHANNEL_ID = 'c'.repeat(26);
const stateFile = path.join(tmpWorkDir, 'mattermost_sync_state.json');
const artifactRoot = path.join(tmpWorkDir, 'knowledge_sources', 'mattermost');
const configFile = path.join(tmpWorkDir, 'config', 'mattermost.json');

function writeConfig(config: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf-8');
}

function readState() {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

/** Rewind a source's lastSyncAt so it counts as due again. */
function rewindSource(sourceId: string, ms: number) {
    const state = readState();
    state.sources[sourceId].lastSyncAt = new Date(Date.now() - ms).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf-8');
}

// --- Fixtures shaped like the real REST API v4 responses ---

function post(overrides: Partial<MattermostPost> & { id: string }): MattermostPost {
    return {
        create_at: 1751900000000,
        update_at: 1751900000000,
        edit_at: 0,
        delete_at: 0,
        user_id: 'user-jorge-id-abcdefghijklmn',
        channel_id: CHANNEL_ID,
        root_id: '',
        message: 'hola equipo',
        type: '',
        ...overrides,
    };
}

/** Real shape: order newest-first, posts as an id-keyed map. */
function postsResponse(posts: MattermostPost[]): MattermostPostsResponse {
    const sorted = [...posts].sort((a, b) => b.create_at - a.create_at);
    return {
        order: sorted.map(p => p.id),
        posts: Object.fromEntries(posts.map(p => [p.id, p])),
    };
}

const USERS = [
    { id: 'user-jorge-id-abcdefghijklmn', username: 'jorge' },
    { id: 'user-dani-id-abcdefghijklmno', username: 'dani' },
];

type Route = { pattern: RegExp; status?: number; body: unknown };

/** Injectable fetch: matches routes against URL, records calls. Zero real network. */
function fakeFetch(routes: Route[]) {
    const calls: { url: string; method: string; body?: string }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
        for (const route of routes) {
            if (route.pattern.test(url)) {
                return new Response(JSON.stringify(route.body), {
                    status: route.status ?? 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        }
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }) as typeof fetch;
    return { impl, calls };
}

function defaultRoutes(posts: MattermostPost[]): Route[] {
    return [
        { pattern: /\/api\/v4\/channels\/[^/]+\/posts/, body: postsResponse(posts) },
        { pattern: /\/api\/v4\/users\/ids$/, body: USERS },
        { pattern: /\/api\/v4\/teams\/name\/believe\/channels\/name\/paid-media$/, body: { id: CHANNEL_ID, name: 'paid-media' } },
    ];
}

beforeAll(async () => {
    sync = await import('./sync_mattermost.js');
});

beforeEach(() => {
    fs.rmSync(stateFile, { force: true });
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    fs.rmSync(configFile, { force: true });
    writeConfig({ url: MM_URL, token: 'test-token', channels: [CHANNEL_ID], teamName: 'believe' });
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('syncMattermostKnowledgeSources artifacts', () => {
    it('writes one frontmattered .md per post with the slack-pattern frontmatter', async () => {
        const p = post({ id: 'post-1', create_at: 1751900000000, message: 'CPA bajó 12% tras el cambio de creativos' });
        const { impl } = fakeFetch(defaultRoutes([p]));
        const files = await sync.syncMattermostKnowledgeSources(impl);
        expect(files).toHaveLength(1);

        const content = fs.readFileSync(files[0], 'utf-8');
        const occurredAt = new Date(1751900000000).toISOString();
        expect(content).toMatch(/^---\n/);
        expect(content).toContain('source: mattermost');
        expect(content).toContain('source_id: be-chat');
        expect(content).toContain(`external_id: ${JSON.stringify(`${MM_URL}:${CHANNEL_ID}:post-1`)}`);
        expect(content).toContain('version: "1751900000000"');
        expect(content).toContain(`occurred_at: ${JSON.stringify(occurredAt)}`);
        expect(content).toContain(`url: ${JSON.stringify(`${MM_URL}/believe/pl/post-1`)}`);
        // Body: channel/author/timestamp/message.
        expect(content).toContain('**Author:** jorge');
        expect(content).toContain(`**Timestamp:** ${occurredAt}`);
        expect(content).toContain('## Message');
        expect(content).toContain('CPA bajó 12% tras el cambio de creativos');
    });

    it('resolves channels given by name via the team endpoint', async () => {
        writeConfig({ url: MM_URL, token: 'test-token', channels: ['paid-media'], teamName: 'believe' });
        const p = post({ id: 'post-2' });
        const { impl, calls } = fakeFetch(defaultRoutes([p]));
        const files = await sync.syncMattermostKnowledgeSources(impl);
        expect(files).toHaveLength(1);
        expect(calls.some(c => c.url === `${MM_URL}/api/v4/teams/name/believe/channels/name/paid-media`)).toBe(true);
        // Artifacts land under the resolved channel name.
        expect(files[0]).toContain(path.join('mattermost', 'paid-media'));
        expect(fs.readFileSync(files[0], 'utf-8')).toContain(`external_id: ${JSON.stringify(`${MM_URL}:${CHANNEL_ID}:post-2`)}`);
    });

    it('uses edit_at as version for edited posts and marks thread replies', async () => {
        const edited = post({ id: 'post-3', create_at: 1751900000000, edit_at: 1751900500000, message: 'editado' });
        const reply = post({ id: 'post-4', create_at: 1751900100000, root_id: 'post-3', message: 'respuesta en hilo' });
        const { impl } = fakeFetch(defaultRoutes([edited, reply]));
        const files = await sync.syncMattermostKnowledgeSources(impl);
        expect(files).toHaveLength(2);

        const editedContent = fs.readFileSync(files.find(f => f.includes('post-3'))!, 'utf-8');
        expect(editedContent).toContain('version: "1751900500000"');
        const replyContent = fs.readFileSync(files.find(f => f.includes('post-4'))!, 'utf-8');
        expect(replyContent).toContain('**Thread root:** post-3');
    });

    it('filters system and bot posts (type !== "") and deleted posts', async () => {
        const user = post({ id: 'post-5' });
        const joined = post({ id: 'post-6', type: 'system_join_channel', message: 'user joined the channel' });
        const botAdd = post({ id: 'post-7', type: 'system_add_to_channel' });
        const deleted = post({ id: 'post-8', delete_at: 1751900900000 });
        const { impl } = fakeFetch(defaultRoutes([user, joined, botAdd, deleted]));
        const files = await sync.syncMattermostKnowledgeSources(impl);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('post-5');
    });

    it('is idempotent: a second run does not rewrite unchanged artifacts', async () => {
        const p = post({ id: 'post-9' });
        const first = await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([p])).impl);
        expect(first).toHaveLength(1);
        const mtime = fs.statSync(first[0]).mtimeMs;

        rewindSource('be-chat', 60 * 60 * 1000);
        const second = await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([p])).impl);
        expect(second).toHaveLength(0);
        expect(fs.statSync(first[0]).mtimeMs).toBe(mtime);
    });
});

describe('since watermark', () => {
    it('first run queries without since, then advances lastPostAt and passes it as since', async () => {
        const p1 = post({ id: 'post-10', create_at: 1751900000000 });
        const run1 = fakeFetch(defaultRoutes([p1]));
        await sync.syncMattermostKnowledgeSources(run1.impl);
        const firstPostsCall = run1.calls.find(c => c.url.includes('/posts'));
        expect(firstPostsCall!.url).not.toContain('since=');
        expect(readState().channels[`be-chat:${CHANNEL_ID}`].lastPostAt).toBe(1751900000000);

        rewindSource('be-chat', 60 * 60 * 1000);
        const p2 = post({ id: 'post-11', create_at: 1751901000000, message: 'nuevo' });
        const run2 = fakeFetch(defaultRoutes([p2]));
        const files = await sync.syncMattermostKnowledgeSources(run2.impl);
        const secondPostsCall = run2.calls.find(c => c.url.includes('/posts'));
        expect(secondPostsCall!.url).toContain('since=1751900000000');
        expect(files).toHaveLength(1);
        expect(readState().channels[`be-chat:${CHANNEL_ID}`].lastPostAt).toBe(1751901000000);
    });

    it('picks up an edit of an already-seen post (edit_at moves the watermark)', async () => {
        const p = post({ id: 'post-12', create_at: 1751900000000 });
        await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([p])).impl);

        rewindSource('be-chat', 60 * 60 * 1000);
        const edited = { ...p, edit_at: 1751902000000, update_at: 1751902000000, message: 'mensaje corregido' };
        const files = await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([edited])).impl);
        expect(files).toHaveLength(1);
        expect(fs.readFileSync(files[0], 'utf-8')).toContain('mensaje corregido');
        expect(readState().channels[`be-chat:${CHANNEL_ID}`].lastPostAt).toBe(1751902000000);
    });
});

describe('username resolution', () => {
    it('batches user ids through POST /users/ids and caches them in memory', async () => {
        const p1 = post({ id: 'post-13', user_id: USERS[0].id });
        const p2 = post({ id: 'post-14', create_at: 1751900100000, user_id: USERS[1].id, message: 'yo también' });
        const { impl, calls } = fakeFetch(defaultRoutes([p1, p2]));
        const files = await sync.syncMattermostKnowledgeSources(impl);
        expect(files).toHaveLength(2);

        const userCalls = calls.filter(c => c.url.endsWith('/users/ids'));
        expect(userCalls).toHaveLength(1);
        expect(JSON.parse(userCalls[0].body!).sort()).toEqual([USERS[0].id, USERS[1].id].sort());
        expect(fs.readFileSync(files.find(f => f.includes('post-14'))!, 'utf-8')).toContain('**Author:** dani');
    });

    it('falls back to the raw user id when the API does not know the user', async () => {
        const p = post({ id: 'post-15', user_id: 'unknown-user-id-xxxxxxxxxxxx' });
        const routes = defaultRoutes([p]);
        routes[1] = { pattern: /\/api\/v4\/users\/ids$/, body: [] };
        const files = await sync.syncMattermostKnowledgeSources(fakeFetch(routes).impl);
        expect(fs.readFileSync(files[0], 'utf-8')).toContain('**Author:** unknown-user-id-xxxxxxxxxxxx');
    });
});

describe('status, errors and backoff', () => {
    it('records ok status and lastSyncAt', async () => {
        await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([])).impl);
        const state = readState();
        expect(state.sources['be-chat'].lastStatus).toBe('ok');
        expect(Date.parse(state.sources['be-chat'].lastSyncAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('grows backoff on 429 rate limits and resets on success', async () => {
        const rateLimited = () => fakeFetch([{ pattern: /\/posts/, status: 429, body: { message: 'rate limited' } }]).impl;
        await sync.syncMattermostKnowledgeSources(rateLimited());
        let s = readState().sources['be-chat'];
        expect(s.lastStatus).toBe('error');
        expect(s.lastError.kind).toBe('rate_limited');
        expect(s.backoffMultiplier).toBe(2);

        rewindSource('be-chat', 60 * 60 * 1000);
        await sync.syncMattermostKnowledgeSources(rateLimited());
        expect(readState().sources['be-chat'].backoffMultiplier).toBe(4);

        rewindSource('be-chat', 60 * 60 * 1000);
        await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([])).impl);
        s = readState().sources['be-chat'];
        expect(s.lastStatus).toBe('ok');
        expect(s.backoffMultiplier).toBeUndefined();
    });

    it('records auth errors on 401 without losing existing channel watermarks', async () => {
        await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([post({ id: 'post-16' })])).impl);
        rewindSource('be-chat', 60 * 60 * 1000);
        await sync.syncMattermostKnowledgeSources(
            fakeFetch([{ pattern: /\/posts/, status: 401, body: { message: 'nope' } }]).impl,
        );
        const state = readState();
        expect(state.sources['be-chat'].lastStatus).toBe('error');
        expect(state.sources['be-chat'].lastError.kind).toBe('auth');
        expect(state.channels[`be-chat:${CHANNEL_ID}`].lastPostAt).toBe(1751900000000);
    });

    it('skips a source that is not yet due', async () => {
        await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([])).impl);
        const run2 = fakeFetch(defaultRoutes([]));
        await sync.syncMattermostKnowledgeSources(run2.impl);
        expect(run2.calls).toHaveLength(0);
    });

    it('skips entirely when mattermost.json is missing', async () => {
        fs.rmSync(configFile, { force: true });
        const { impl, calls } = fakeFetch(defaultRoutes([]));
        const files = await sync.syncMattermostKnowledgeSources(impl);
        expect(files).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });
});

describe('effectiveIntervalMs', () => {
    it('multiplies the base interval by the backoff and caps at 30 minutes', () => {
        expect(sync.effectiveIntervalMs(sourceA, undefined)).toBe(5 * 60 * 1000);
        expect(sync.effectiveIntervalMs(sourceA, { backoffMultiplier: 4 })).toBe(20 * 60 * 1000);
        expect(sync.effectiveIntervalMs(sourceA, { backoffMultiplier: 1024 })).toBe(30 * 60 * 1000);
    });
});

describe('getMattermostSyncStatus', () => {
    it('reports per-source status with nextDueAt', async () => {
        await sync.syncMattermostKnowledgeSources(fakeFetch(defaultRoutes([])).impl);
        const statuses = sync.getMattermostSyncStatus();
        const a = statuses.find(s => s.id === 'be-chat');
        expect(a).toMatchObject({ enabled: true, lastStatus: 'ok' });
        expect(Date.parse(a!.nextDueAt!)).toBeCloseTo(Date.parse(a!.lastSyncAt!) + 5 * 60 * 1000, -3);
    });
});
