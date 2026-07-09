// believe: HTTP transport for the Company Brain (get-maas Edge Functions).
// Contract: BELIEVE-FORK.md — mc-brain-query (read) + mc-company-brain-ingest
// (write), auth via x-api-key header (NOT Bearer).
import { z } from 'zod';
import type { CompanyBrainConfig } from '../config/company_brain_config.js';

/** Episode row returned by mc-brain-query (embedding is never included). */
export const Episode = z.object({
    id: z.string().or(z.number()).optional(),
    source: z.string(),
    external_id: z.string(),
    actors: z.array(z.string()).optional(),
    summary: z.string().optional(),
    decision_summary: z.string().nullish(),
    transcript_ref: z.string().nullish(),
    client_id: z.string().nullish(),
    channel: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).nullish(),
    created_at: z.string().optional(),
}).passthrough();
export type Episode = z.infer<typeof Episode>;

/** Episode payload accepted by mc-company-brain-ingest. */
export const EpisodeInput = z.object({
    source: z.enum(['omi', 'mattermost', 'gmail', 'n8n', 'maasy', 'advault', 'clips', 'manual']),
    external_id: z.string(),
    actors: z.array(z.string()),
    summary: z.string(),
    decision_summary: z.string().optional(),
    transcript_ref: z.string().max(8000).optional(),
    client_id: z.string().optional(),
    channel: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.string().optional(),
});
export type EpisodeInput = z.infer<typeof EpisodeInput>;

/** 200 response of mc-company-brain-ingest. */
export const IngestResult = z.object({
    ok: z.literal(true),
    ingested: z.record(z.string(), z.unknown()),
    skipped: z.record(z.string(), z.unknown()),
}).passthrough();
export type IngestResult = z.infer<typeof IngestResult>;

const QueryResponse = z.object({
    ok: z.literal(true),
    entity: z.string(),
    count: z.number(),
    rows: z.array(Episode),
}).passthrough();

export type BrainTransportErrorKind =
    | 'unauthorized'   // 401
    | 'forbidden'      // 403
    | 'rate_limited'   // 429
    | 'server_error'   // 5xx
    | 'bad_request'    // 400 and other 4xx
    | 'bad_response'   // 200 but unparseable body
    | 'network';       // fetch threw

export class BrainTransportError extends Error {
    constructor(
        public readonly kind: BrainTransportErrorKind,
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'BrainTransportError';
    }
}

function kindForStatus(status: number): BrainTransportErrorKind {
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server_error';
    return 'bad_request';
}

export interface BrainTransport {
    queryEpisodes(opts: { since?: string; offset?: number; limit?: number }): Promise<Episode[]>;
    ingestEpisodes(eps: EpisodeInput[]): Promise<IngestResult>;
}

const DEFAULT_QUERY_LIMIT = 200; // mc-brain-query hard max

export class HttpBrainTransport implements BrainTransport {
    constructor(
        private readonly config: Pick<CompanyBrainConfig, 'apiUrl' | 'apiKey'>,
        private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    ) { }

    private async post(fn: string, body: unknown): Promise<unknown> {
        const url = `${this.config.apiUrl.replace(/\/+$/, '')}/${fn}`;
        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': this.config.apiKey ?? '',
                },
                body: JSON.stringify(body),
            });
        } catch (error) {
            throw new BrainTransportError('network', `Brain request to ${fn} failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        const text = await response.text();
        if (!response.ok) {
            throw new BrainTransportError(
                kindForStatus(response.status),
                `Brain ${fn} returned ${response.status}: ${text.slice(0, 500)}`,
                response.status,
            );
        }

        try {
            return JSON.parse(text);
        } catch {
            throw new BrainTransportError('bad_response', `Brain ${fn} returned unparseable JSON`, response.status);
        }
    }

    async queryEpisodes(opts: { since?: string; offset?: number; limit?: number }): Promise<Episode[]> {
        const filters: Record<string, unknown> = {};
        if (opts.since) filters.since = opts.since;
        const raw = await this.post('mc-brain-query', {
            entity: 'episodes',
            filters,
            limit: Math.min(opts.limit ?? DEFAULT_QUERY_LIMIT, DEFAULT_QUERY_LIMIT),
            offset: opts.offset ?? 0,
        });
        const parsed = QueryResponse.safeParse(raw);
        if (!parsed.success) {
            throw new BrainTransportError('bad_response', `Brain mc-brain-query response shape invalid: ${parsed.error.message}`);
        }
        return parsed.data.rows;
    }

    async ingestEpisodes(eps: EpisodeInput[]): Promise<IngestResult> {
        const episodes = eps.map(ep => EpisodeInput.parse(ep));
        const raw = await this.post('mc-company-brain-ingest', { episodes });
        const parsed = IngestResult.safeParse(raw);
        if (!parsed.success) {
            throw new BrainTransportError('bad_response', `Brain ingest response shape invalid: ${parsed.error.message}`);
        }
        return parsed.data;
    }
}
