// believe: Be Chat (Mattermost) knowledge connector (module 6 of BELIEVE-FORK.md).
// Clone of the sync_slack.ts pattern: poll the Mattermost REST API v4 for new
// posts per configured channel, write frontmattered artifacts under
// knowledge_sources/mattermost/, keep a lastPostAt watermark per channel.
import fs from 'fs';
import path from 'path';
import { WorkDir } from '../../config/config.js';
import { getMattermostConfig } from '../../config/mattermost_config.js';
import type { MattermostConfig } from '../../config/mattermost_config.js';
import { serviceLogger } from '../../services/service_logger.js';
import { limitEventItems } from '../limit_event_items.js';
import { createEvent } from '../../events/producer.js';
import { knowledgeSourcesRepo } from './repo.js';
import type { KnowledgeArtifact, KnowledgeSourceConfig } from './types.js';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SOURCE_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const STATE_FILE = path.join(WorkDir, 'mattermost_sync_state.json');
const ARTIFACT_ROOT = path.join(WorkDir, 'knowledge_sources', 'mattermost');

export type MattermostErrorKind = 'rate_limited' | 'auth' | 'not_found' | 'server_error' | 'network' | 'unknown';

export class MattermostRunError extends Error {
    constructor(public kind: MattermostErrorKind, message: string, public status?: number) {
        super(message);
        this.name = 'MattermostRunError';
    }
}

export type MattermostSourceSyncState = {
    /** Time of the last sync attempt (success or failure). */
    lastSyncAt?: string;
    lastStatus?: 'ok' | 'error';
    lastError?: { kind: MattermostErrorKind; message: string };
    /** Rate-limit backoff: multiplies the source interval; reset on success. */
    backoffMultiplier?: number;
};

type MattermostSyncState = {
    lastSyncAt?: string;
    sources?: Record<string, MattermostSourceSyncState>;
    /** Per-channel watermark: max(create_at, edit_at) in ms seen so far. */
    channels: Record<string, { lastPostAt?: number }>;
};

/** Shape of a post as returned by GET /api/v4/channels/{id}/posts. */
export type MattermostPost = {
    id: string;
    create_at: number;
    update_at?: number;
    edit_at?: number;
    delete_at?: number;
    user_id: string;
    channel_id: string;
    root_id?: string;
    message: string;
    /** '' for regular user posts; anything else is a system/bot event. */
    type?: string;
};

/** Shape of GET /api/v4/channels/{id}/posts responses. */
export type MattermostPostsResponse = {
    order: string[];
    posts: Record<string, MattermostPost>;
};

type MattermostUser = { id: string; username?: string };

function loadState(): MattermostSyncState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<MattermostSyncState>;
            return { channels: {}, ...parsed };
        }
    } catch (error) {
        console.error('[MattermostKnowledge] Failed to load state:', error);
    }
    return { channels: {} };
}

function saveState(state: MattermostSyncState): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Source interval with rate-limit backoff applied, capped at 30 minutes. */
export function effectiveIntervalMs(source: KnowledgeSourceConfig, sourceState?: MattermostSourceSyncState): number {
    const base = source.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    const multiplier = Math.max(1, sourceState?.backoffMultiplier ?? 1);
    return Math.min(base * multiplier, MAX_SOURCE_SYNC_INTERVAL_MS);
}

function isSourceDue(source: KnowledgeSourceConfig, state: MattermostSyncState): boolean {
    const sourceState = state.sources?.[source.id];
    if (!sourceState?.lastSyncAt) return true;
    const lastSyncMs = Date.parse(sourceState.lastSyncAt);
    return !Number.isFinite(lastSyncMs) || Date.now() - lastSyncMs >= effectiveIntervalMs(source, sourceState);
}

function safeSegment(value: string): string {
    return value
        .replace(/^https?:\/\//, '')
        // Neutralize traversal sequences BEFORE separators so a malicious
        // server value ("../../../etc/x") can never escape the artifact dir.
        .replace(/\.{2,}/g, '_')
        .replace(/[\\/*?:"<>|#\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 120) || 'unknown';
}

/** Mattermost ids are 26 chars of [a-z0-9]; channel names may collide only in theory. */
function looksLikeChannelId(value: string): boolean {
    return /^[a-z0-9]{26}$/.test(value);
}

/** REST API v4 client with injectable fetch (tests never hit the network). */
class MattermostClient {
    private baseUrl: string;
    private userCache = new Map<string, string>();
    private channelCache = new Map<string, { id: string; name: string }>();

    constructor(private config: MattermostConfig, private fetchImpl: typeof fetch) {
        this.baseUrl = config.url.replace(/\/+$/, '');
    }

    private async request(pathname: string, init?: { method?: string; body?: string }): Promise<unknown> {
        let response: Response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/api/v4${pathname}`, {
                method: init?.method ?? 'GET',
                headers: {
                    Authorization: `Bearer ${this.config.token}`,
                    'Content-Type': 'application/json',
                },
                body: init?.body,
            });
        } catch (error) {
            throw new MattermostRunError('network', error instanceof Error ? error.message : String(error));
        }
        if (!response.ok) {
            const kind: MattermostErrorKind =
                response.status === 429 ? 'rate_limited'
                    : response.status === 401 || response.status === 403 ? 'auth'
                        : response.status === 404 ? 'not_found'
                            : response.status >= 500 ? 'server_error'
                                : 'unknown';
            throw new MattermostRunError(kind, `Mattermost API ${pathname} failed: HTTP ${response.status}`, response.status);
        }
        return response.json();
    }

    /** Resolve a channel given by id or name to { id, name }. */
    async resolveChannel(channel: string): Promise<{ id: string; name: string }> {
        const cached = this.channelCache.get(channel);
        if (cached) return cached;

        let resolved: { id: string; name: string };
        if (looksLikeChannelId(channel)) {
            resolved = { id: channel, name: channel };
        } else {
            if (!this.config.teamName) {
                throw new MattermostRunError('unknown', `Channel "${channel}" is a name but no teamName is configured`);
            }
            const data = await this.request(
                `/teams/name/${encodeURIComponent(this.config.teamName)}/channels/name/${encodeURIComponent(channel)}`,
            ) as { id?: string; name?: string };
            if (!data.id) {
                throw new MattermostRunError('not_found', `Channel "${channel}" not found in team ${this.config.teamName}`);
            }
            resolved = { id: data.id, name: data.name ?? channel };
        }
        this.channelCache.set(channel, resolved);
        return resolved;
    }

    /**
     * One page of posts, newest-first. We paginate with page+per_page instead
     * of ?since= because the API caps since-responses (typically 1000 posts),
     * so a first sync or a large burst would silently lose history.
     */
    async listPosts(channelId: string, page: number, perPage: number): Promise<MattermostPostsResponse> {
        const query = `?page=${page}&per_page=${perPage}`;
        const data = await this.request(`/channels/${encodeURIComponent(channelId)}/posts${query}`) as Partial<MattermostPostsResponse>;
        return { order: data.order ?? [], posts: data.posts ?? {} };
    }

    /** Resolve user ids to usernames via POST /users/ids (batched, memory-cached). */
    async resolveUsernames(userIds: string[]): Promise<Map<string, string>> {
        const missing = Array.from(new Set(userIds)).filter(id => !this.userCache.has(id));
        if (missing.length > 0) {
            const users = await this.request('/users/ids', { method: 'POST', body: JSON.stringify(missing) }) as MattermostUser[];
            for (const user of Array.isArray(users) ? users : []) {
                if (user.id) this.userCache.set(user.id, user.username ?? user.id);
            }
        }
        const result = new Map<string, string>();
        for (const id of userIds) {
            result.set(id, this.userCache.get(id) ?? id);
        }
        return result;
    }
}

function permalink(config: MattermostConfig, postId: string): string {
    const base = config.url.replace(/\/+$/, '');
    // /_redirect/pl/<id> works without knowing the team; prefer the team path when we have it.
    return config.teamName
        ? `${base}/${config.teamName}/pl/${postId}`
        : `${base}/_redirect/pl/${postId}`;
}

export function artifactForPost(
    source: KnowledgeSourceConfig,
    config: MattermostConfig,
    channel: { id: string; name: string },
    post: MattermostPost,
    author: string,
): KnowledgeArtifact {
    const occurredAt = new Date(post.create_at).toISOString();
    const version = String(post.edit_at || post.create_at);
    const url = permalink(config, post.id);
    const title = `Mattermost message in ${channel.name}`;
    const body = (post.message ?? '').trim();

    const bodyMarkdown = [
        `# ${title}`,
        ``,
        `**Server:** ${config.url}`,
        `**Channel:** ${channel.name}`,
        `**Author:** ${author}`,
        `**Timestamp:** ${occurredAt}`,
        post.root_id ? `**Thread root:** ${post.root_id}` : '',
        `**Link:** ${url}`,
        ``,
        `## Message`,
        ``,
        body,
    ].filter(line => line !== '').join('\n');

    return {
        sourceId: source.id,
        provider: 'mattermost',
        externalId: `${config.url}:${channel.id}:${post.id}`,
        version,
        occurredAt,
        title,
        bodyMarkdown,
        url,
        metadata: {
            serverUrl: config.url,
            channelId: channel.id,
            channelName: channel.name,
            author,
            postId: post.id,
            rootId: post.root_id || undefined,
            createAt: post.create_at,
            editAt: post.edit_at || undefined,
        },
    };
}

function writeArtifact(source: KnowledgeSourceConfig, channel: { id: string; name: string }, artifact: KnowledgeArtifact): string | null {
    const dir = path.join(
        WorkDir,
        source.artifactDir || path.join('knowledge_sources', 'mattermost'),
        safeSegment(channel.name),
    );
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${safeSegment(artifact.metadata.postId as string)}.md`);
    const frontmatter = [
        '---',
        `source: ${artifact.provider}`,
        `source_id: ${artifact.sourceId}`,
        `external_id: ${JSON.stringify(artifact.externalId)}`,
        `version: ${JSON.stringify(artifact.version)}`,
        `occurred_at: ${JSON.stringify(artifact.occurredAt)}`,
        artifact.url ? `url: ${JSON.stringify(artifact.url)}` : '',
        '---',
        '',
    ].filter(Boolean).join('\n');

    const content = `${frontmatter}${artifact.bodyMarkdown}\n`;
    if (fs.existsSync(filePath)) {
        try {
            if (fs.readFileSync(filePath, 'utf-8') === content) {
                return null;
            }
        } catch {
            // Fall through and rewrite the artifact.
        }
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

async function publishMattermostSyncEvent(files: string[]): Promise<void> {
    if (files.length === 0) return;
    const relativeFiles = files.map(file => path.relative(WorkDir, file));
    await createEvent({
        source: 'mattermost',
        type: 'mattermost.synced',
        createdAt: new Date().toISOString(),
        payload: [
            '# Mattermost knowledge sync update',
            '',
            `${files.length} new/updated message artifact${files.length === 1 ? '' : 's'}.`,
            '',
            ...relativeFiles.slice(0, 20).map(file => `- ${file}`),
        ].join('\n'),
    });
}

/**
 * Sync one source's channels into artifact files. Mutates state.channels as
 * it goes; throws MattermostRunError on API failure (status bookkeeping is
 * the caller's job).
 */
async function syncSource(
    source: KnowledgeSourceConfig,
    state: MattermostSyncState,
    config: MattermostConfig,
    client: MattermostClient,
): Promise<string[]> {
    if (config.channels.length === 0) {
        console.log(`[MattermostKnowledge] Source ${source.id} has no channels configured; skipping`);
        return [];
    }

    const writtenFiles: string[] = [];

    for (const channelRef of config.channels) {
        const channel = await client.resolveChannel(channelRef);
        const key = `${source.id}:${channel.id}`;
        const channelState = state.channels[key] ?? {};

        // Page through the channel (newest-first, PER_PAGE at a time) until a
        // short page ends the stream or the page's oldest post falls at or
        // below the watermark — the first sync and large bursts both drain
        // fully instead of being capped by a single ?since= response.
        const PER_PAGE = 200;
        const fetched: MattermostPost[] = [];
        for (let page = 0; ; page++) {
            const response = await client.listPosts(channel.id, page, PER_PAGE);
            const pagePosts = response.order
                .map(id => response.posts[id])
                .filter((post): post is MattermostPost => Boolean(post));
            fetched.push(...pagePosts);
            if (response.order.length < PER_PAGE) break;
            const oldestCreateAt = Math.min(...pagePosts.map(post => post.create_at));
            if (channelState.lastPostAt !== undefined && oldestCreateAt <= channelState.lastPostAt) break;
        }

        // Process oldest-first, only real user posts (type !== '' means
        // system/bot event) and non-deleted.
        const posts = fetched
            .filter(post => (post.type ?? '') === '' && !post.delete_at)
            .sort((a, b) => a.create_at - b.create_at);

        const usernames = await client.resolveUsernames(posts.map(post => post.user_id));

        let newestPostAt = channelState.lastPostAt ?? 0;
        for (const post of posts) {
            const activityAt = Math.max(post.create_at, post.edit_at ?? 0, post.update_at ?? 0);
            if (channelState.lastPostAt !== undefined && activityAt <= channelState.lastPostAt) {
                continue;
            }
            const author = usernames.get(post.user_id) ?? post.user_id;
            const artifact = artifactForPost(source, config, channel, post, author);
            const writtenFile = writeArtifact(source, channel, artifact);
            if (writtenFile) {
                writtenFiles.push(writtenFile);
            }
            if (activityAt > newestPostAt) {
                newestPostAt = activityAt;
            }
        }

        state.channels[key] = { lastPostAt: newestPostAt > 0 ? newestPostAt : channelState.lastPostAt };
    }

    return writtenFiles;
}

function recordSourceResult(state: MattermostSyncState, sourceId: string, error?: { kind: MattermostErrorKind; message: string }): void {
    const previous = state.sources?.[sourceId];
    const now = new Date().toISOString();
    const next: MattermostSourceSyncState = { lastSyncAt: now };
    if (error) {
        next.lastStatus = 'error';
        next.lastError = error;
        if (error.kind === 'rate_limited') {
            // Doubles each consecutive rate limit; effectiveIntervalMs caps
            // the resulting interval at 30 min, the clamp keeps the stored
            // value sane in the state file.
            next.backoffMultiplier = Math.min(Math.max(2, (previous?.backoffMultiplier ?? 1) * 2), 1024);
        }
    } else {
        next.lastStatus = 'ok';
    }
    state.lastSyncAt = now;
    state.sources = { ...(state.sources ?? {}), [sourceId]: next };
}

/**
 * Sync every enabled mattermost source. Optional fetch injection for tests;
 * production uses global fetch. Skips entirely when WorkDir/config/
 * mattermost.json is missing or invalid.
 */
export async function syncMattermostKnowledgeSources(fetchOverride?: typeof fetch): Promise<string[]> {
    const state = loadState();
    const sources = knowledgeSourcesRepo
        .listEnabledSources()
        .filter(source => source.provider === 'mattermost' && source.syncMode === 'poll')
        .filter(source => isSourceDue(source, state));

    if (sources.length === 0) return [];

    const config = getMattermostConfig();
    if (!config || !config.url || !config.token) {
        console.log('[MattermostKnowledge] Mattermost not configured; skipping sync');
        return [];
    }

    const client = new MattermostClient(config, fetchOverride ?? fetch);

    const run = await serviceLogger.startRun({
        service: 'mattermost',
        message: 'Syncing Mattermost knowledge sources',
        trigger: 'timer',
    });

    const writtenFiles: string[] = [];
    let hadError = false;

    for (const source of sources) {
        let rateLimited = false;
        try {
            const files = await syncSource(source, state, config, client);
            writtenFiles.push(...files);
            recordSourceResult(state, source.id);
        } catch (error) {
            // One failing source must not abort the others.
            hadError = true;
            const kind = error instanceof MattermostRunError ? error.kind : 'unknown';
            const message = error instanceof Error ? error.message : String(error);
            recordSourceResult(state, source.id, { kind, message });
            rateLimited = kind === 'rate_limited';
            console.error(`[MattermostKnowledge] Sync failed for source ${source.id} (${kind}):`, message);
            await serviceLogger.log({
                type: 'error',
                service: run.service,
                runId: run.runId,
                level: 'error',
                message: `Mattermost knowledge sync error for source ${source.id} (${kind})`,
                error: message,
            });
        }
        // Persist after every source so progress and status survive a crash.
        saveState(state);
        // Rate limits are per-token, so the remaining sources would hit the
        // same wall — end this run; they stay due for the next tick.
        if (rateLimited) break;
    }

    if (writtenFiles.length > 0) {
        try {
            const relativeFiles = writtenFiles.map(file => path.relative(WorkDir, file));
            const limitedFiles = limitEventItems(relativeFiles);
            await serviceLogger.log({
                type: 'changes_identified',
                service: run.service,
                runId: run.runId,
                level: 'info',
                message: `Mattermost updates: ${writtenFiles.length} message artifact${writtenFiles.length === 1 ? '' : 's'}`,
                counts: { messages: writtenFiles.length },
                items: limitedFiles.items,
                truncated: limitedFiles.truncated,
            });
            await publishMattermostSyncEvent(writtenFiles);
        } catch (error) {
            hadError = true;
            console.error('[MattermostKnowledge] Failed to publish sync results:', error);
        }
    }

    await serviceLogger.log({
        type: 'run_complete',
        service: run.service,
        runId: run.runId,
        level: hadError ? 'error' : 'info',
        message: `Mattermost sync complete: ${writtenFiles.length} artifact${writtenFiles.length === 1 ? '' : 's'}`,
        durationMs: Date.now() - run.startedAt,
        outcome: hadError ? 'error' : 'ok',
        summary: { artifacts: writtenFiles.length },
    });

    return writtenFiles;
}

export function getMattermostArtifactRoot(): string {
    return ARTIFACT_ROOT;
}

export type MattermostSourceStatus = {
    id: string;
    enabled: boolean;
    lastSyncAt?: string;
    lastStatus?: 'ok' | 'error';
    lastError?: { kind: string; message: string };
    /** When the source next becomes due, given interval + backoff. */
    nextDueAt?: string;
};

/** Per-source sync status for the mattermost:knowledgeStatus IPC channel. */
export function getMattermostSyncStatus(): MattermostSourceStatus[] {
    const state = loadState();
    return knowledgeSourcesRepo
        .getConfig()
        .sources
        .filter(source => source.provider === 'mattermost')
        .map(source => {
            const sourceState = state.sources?.[source.id];
            const lastMs = sourceState?.lastSyncAt ? Date.parse(sourceState.lastSyncAt) : NaN;
            return {
                id: source.id,
                enabled: source.enabled,
                lastSyncAt: sourceState?.lastSyncAt,
                lastStatus: sourceState?.lastStatus,
                lastError: sourceState?.lastError,
                nextDueAt: Number.isFinite(lastMs)
                    ? new Date(lastMs + effectiveIntervalMs(source, sourceState)).toISOString()
                    : undefined,
            };
        });
}

let wakeResolve: (() => void) | null = null;

export function triggerSync(): void {
    if (wakeResolve) {
        wakeResolve();
        wakeResolve = null;
    }
}

function interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            wakeResolve = null;
            resolve();
        }, ms);
        wakeResolve = () => {
            clearTimeout(timeout);
            resolve();
        };
    });
}

export async function init(): Promise<void> {
    console.log(`[MattermostKnowledge] Starting Mattermost knowledge sync. Polling every ${DEFAULT_SYNC_INTERVAL_MS / 1000}s`);
    while (true) {
        await syncMattermostKnowledgeSources();
        await interruptibleSleep(DEFAULT_SYNC_INTERVAL_MS);
    }
}
