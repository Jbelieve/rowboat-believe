// believe: tests for HttpBrainTransport — injected fetch mock, zero real network.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// WorkDir resolves when config.js loads (transitively via transport's config
// type import chain) — set before any dynamic import, pattern sync_slack.test.ts.
const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-transport-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;

const { HttpBrainTransport, BrainTransportError } = await import('./transport.js');
type EpisodeInput = import('./transport.js').EpisodeInput;

const config = { apiUrl: 'https://brain.test/functions/v1', apiKey: 'mc_deadbeef_test' };

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const episode = (n: number) => ({
    id: `ep-${n}`,
    source: 'omi',
    external_id: `omi:${n}`,
    summary: `episode ${n}`,
    channel: 'voice',
    created_at: `2026-07-0${n}T00:00:00Z`,
});

const input: EpisodeInput = {
    source: 'manual',
    external_id: 'desktop:notes/test.md',
    actors: ['jorge'],
    summary: 'a test note',
    channel: 'desktop',
    metadata: { path: 'notes/test.md' },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
});

function transport() {
    return new HttpBrainTransport(config, fetchMock as unknown as typeof fetch);
}

describe('queryEpisodes', () => {
    it('sends x-api-key, since filter and pagination, returns rows', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {
            ok: true, entity: 'episodes', count: 2, rows: [episode(1), episode(2)],
        }));

        const rows = await transport().queryEpisodes({ since: '2026-07-01T00:00:00Z', offset: 40, limit: 20 });

        expect(rows).toHaveLength(2);
        expect(rows[0].external_id).toBe('omi:1');
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://brain.test/functions/v1/mc-brain-query');
        expect(init.headers['x-api-key']).toBe('mc_deadbeef_test');
        expect(JSON.parse(init.body)).toEqual({
            entity: 'episodes',
            filters: { since: '2026-07-01T00:00:00Z' },
            limit: 20,
            offset: 40,
        });
    });

    it('defaults offset 0 / limit 200 and omits since when absent', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, entity: 'episodes', count: 0, rows: [] }));
        await transport().queryEpisodes({});
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual({ entity: 'episodes', filters: {}, limit: 200, offset: 0 });
    });

    it('caps limit at 200 (EF hard max)', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, entity: 'episodes', count: 0, rows: [] }));
        await transport().queryEpisodes({ limit: 999 });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBe(200);
    });

    it('throws unauthorized on 401', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(401, { ok: false, error: 'bad key' }));
        const err = await transport().queryEpisodes({}).catch(e => e);
        expect(err).toBeInstanceOf(BrainTransportError);
        expect(err.kind).toBe('unauthorized');
        expect(err.status).toBe(401);
    });

    it('throws rate_limited on 429 and server_error on 500', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'slow down' }));
        await expect(transport().queryEpisodes({})).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });

        fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
        await expect(transport().queryEpisodes({})).rejects.toMatchObject({ kind: 'server_error', status: 500 });
    });

    it('throws network on fetch failure', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
        await expect(transport().queryEpisodes({})).rejects.toMatchObject({ kind: 'network' });
    });

    it('throws bad_response on malformed 200 body', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, unexpected: true }));
        await expect(transport().queryEpisodes({})).rejects.toMatchObject({ kind: 'bad_response' });
    });
});

describe('ingestEpisodes', () => {
    it('posts episodes batch and returns ingested/skipped', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(200, {
            ok: true, ingested: { count: 1 }, skipped: { count: 0 },
        }));

        const result = await transport().ingestEpisodes([input]);

        expect(result.ok).toBe(true);
        expect(result.ingested).toEqual({ count: 1 });
        expect(result.skipped).toEqual({ count: 0 });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://brain.test/functions/v1/mc-company-brain-ingest');
        expect(init.headers['x-api-key']).toBe('mc_deadbeef_test');
        expect(JSON.parse(init.body)).toEqual({ episodes: [input] });
    });

    it('rejects invalid episode input locally (bad source enum)', async () => {
        await expect(
            transport().ingestEpisodes([{ ...input, source: 'desktop' as EpisodeInput['source'] }]),
        ).rejects.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws forbidden on 403 and unauthorized on 401', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'missing scope' }));
        await expect(transport().ingestEpisodes([input])).rejects.toMatchObject({ kind: 'forbidden', status: 403 });

        fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'nope' }));
        await expect(transport().ingestEpisodes([input])).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    });

    it('throws rate_limited on 429', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'slow down' }));
        await expect(transport().ingestEpisodes([input])).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
    });
});
