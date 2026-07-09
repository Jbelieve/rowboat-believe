// believe: Company Brain pull source (module 2 of BELIEVE-FORK.md).
// Clone of the sync_slack.ts pattern: poll mc-brain-query via BrainTransport,
// write frontmattered artifacts under knowledge_sources/company_brain/, keep
// a watermark (lastCreatedAt) with a 24h overlap window + per-run id dedup
// because created_at can arrive retroactively (omi sets the conversation
// date). Conflict rule: the central brain ALWAYS wins — inside the overlap
// window every episode is re-materialized through writeArtifact (idempotent:
// unchanged content is a no-op, central edits overwrite the local artifact).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WorkDir } from '../../config/config.js';
import { getCompanyBrainConfig, getDeviceId } from '../../config/company_brain_config.js';
import { HttpBrainTransport, BrainTransportError } from '../../brain/transport.js';
import type { BrainTransport, Episode } from '../../brain/transport.js';
import { serviceLogger } from '../../services/service_logger.js';
import { limitEventItems } from '../limit_event_items.js';
import { createEvent } from '../../events/producer.js';
import { knowledgeSourcesRepo } from './repo.js';
import type { KnowledgeArtifact, KnowledgeSourceConfig } from './types.js';

const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SOURCE_SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** Overlap window re-queried each pull to catch retroactive created_at rows. */
const WATERMARK_OVERLAP_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 200; // mc-brain-query hard max
const STATE_FILE = path.join(WorkDir, 'company_brain_sync_state.json');
const ARTIFACT_ROOT = path.join(WorkDir, 'knowledge_sources', 'company_brain');

export type CompanyBrainSourceSyncState = {
    /** Time of the last sync attempt (success or failure). */
    lastSyncAt?: string;
    lastStatus?: 'ok' | 'error';
    lastError?: { kind: string; message: string };
    /** Rate-limit backoff: multiplies the source interval; reset on success. */
    backoffMultiplier?: number;
    /** Watermark: max created_at seen across all pulled episodes (clamped to now). */
    lastCreatedAt?: string;
};

type CompanyBrainSyncState = {
    lastSyncAt?: string;
    sources?: Record<string, CompanyBrainSourceSyncState>;
};

function loadState(): CompanyBrainSyncState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as CompanyBrainSyncState;
        }
    } catch (error) {
        console.error('[CompanyBrainKnowledge] Failed to load state:', error);
    }
    return {};
}

function saveState(state: CompanyBrainSyncState): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Source interval with rate-limit backoff applied, capped at 30 minutes. */
export function effectiveIntervalMs(source: KnowledgeSourceConfig, sourceState?: CompanyBrainSourceSyncState): number {
    const base = source.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    const multiplier = Math.max(1, sourceState?.backoffMultiplier ?? 1);
    return Math.min(base * multiplier, MAX_SOURCE_SYNC_INTERVAL_MS);
}

function isSourceDue(source: KnowledgeSourceConfig, state: CompanyBrainSyncState): boolean {
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

function episodeId(episode: Episode): string {
    if (episode.id !== undefined && episode.id !== null) return String(episode.id);
    return `${episode.source}:${episode.external_id}`;
}

/** Episode created_at as ISO, or null when missing/invalid — a dateless
 * episode must not contaminate the watermark nor get a per-tick version. */
function episodeCreatedAt(episode: Episode): string | null {
    if (episode.created_at && Number.isFinite(Date.parse(episode.created_at))) {
        return new Date(Date.parse(episode.created_at)).toISOString();
    }
    return null;
}

export function artifactForEpisode(source: KnowledgeSourceConfig, episode: Episode): KnowledgeArtifact {
    const createdAt = episodeCreatedAt(episode);
    // Dateless episodes get a stable version derived from the id (never
    // "now", which would rewrite the artifact every tick) and epoch as the
    // placeholder occurred_at.
    const version = createdAt ?? `no-date:${episodeId(episode)}`;
    const occurredAt = createdAt ?? new Date(0).toISOString();
    const summary = (episode.summary ?? '').trim();
    const title = summary.split('\n')[0]?.slice(0, 200) || `Company Brain episode ${episode.external_id}`;
    const actors = episode.actors ?? [];
    const channel = episode.channel ?? '';

    const metadataEntries = Object.entries(episode.metadata ?? {});
    const bodyMarkdown = [
        `# ${title}`,
        ``,
        `**Source:** ${episode.source}`,
        actors.length > 0 ? `**Actors:** ${actors.join(', ')}` : '',
        channel ? `**Channel:** ${channel}` : '',
        episode.client_id ? `**Client:** ${episode.client_id}` : '',
        `**Occurred at:** ${occurredAt}`,
        ``,
        `## Summary`,
        ``,
        summary || '(no summary)',
        episode.decision_summary ? `\n## Decisions\n\n${episode.decision_summary}` : '',
        episode.transcript_ref ? `\n## Transcript\n\n${episode.transcript_ref}` : '',
        metadataEntries.length > 0
            ? `\n## Metadata\n\n${metadataEntries.map(([k, v]) => `- **${k}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}`
            : '',
    ].filter(line => line !== '').join('\n');

    return {
        sourceId: source.id,
        provider: 'company_brain',
        externalId: `brain:${episodeId(episode)}`,
        version,
        occurredAt,
        title,
        bodyMarkdown,
        metadata: {
            episodeSource: episode.source,
            brainExternalId: episode.external_id,
            actors,
            channel,
            clientId: episode.client_id ?? undefined,
        },
    };
}

function writeArtifact(source: KnowledgeSourceConfig, episode: Episode, artifact: KnowledgeArtifact): string | null {
    const dir = path.join(
        WorkDir,
        source.artifactDir || path.join('knowledge_sources', 'company_brain'),
        safeSegment(episode.source),
    );
    fs.mkdirSync(dir, { recursive: true });

    // Short hash suffix disambiguates external_ids that collide after
    // safeSegment's 120-char truncation.
    const nameHash = crypto.createHash('sha256').update(episode.external_id).digest('hex').slice(0, 8);
    const filePath = path.join(dir, `${safeSegment(episode.external_id)}-${nameHash}.md`);
    const frontmatter = [
        '---',
        `source: ${artifact.provider}`,
        `source_id: ${artifact.sourceId}`,
        `external_id: ${JSON.stringify(artifact.externalId)}`,
        `version: ${JSON.stringify(artifact.version)}`,
        `occurred_at: ${JSON.stringify(artifact.occurredAt)}`,
        // believe: marks the artifact as centrally-owned so the fanout
        // producer never pushes it back (echo guard). Central-wins conflict
        // resolution lives inline in the pull: every episode inside the
        // overlap window is re-written through the idempotent writeArtifact.
        'brain_origin: central',
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

async function publishCompanyBrainSyncEvent(files: string[]): Promise<void> {
    if (files.length === 0) return;
    const relativeFiles = files.map(file => path.relative(WorkDir, file));
    await createEvent({
        source: 'company_brain',
        type: 'company_brain.synced',
        createdAt: new Date().toISOString(),
        payload: [
            '# Company Brain knowledge sync update',
            '',
            `${files.length} new/updated episode artifact${files.length === 1 ? '' : 's'}.`,
            '',
            ...relativeFiles.slice(0, 20).map(file => `- ${file}`),
        ].join('\n'),
    });
}

/**
 * Pull one source's episodes into artifact files. Mutates the per-source
 * state (watermark + seenIds); throws BrainTransportError on HTTP failure
 * (status bookkeeping is the caller's job).
 */
async function syncSource(
    source: KnowledgeSourceConfig,
    state: CompanyBrainSyncState,
    transport: BrainTransport,
): Promise<string[]> {
    const sourceState = state.sources?.[source.id] ?? {};
    const watermarkMs = sourceState.lastCreatedAt ? Date.parse(sourceState.lastCreatedAt) : NaN;
    // Re-query a 24h overlap window: created_at can be retroactive.
    const since = Number.isFinite(watermarkMs)
        ? new Date(watermarkMs - WATERMARK_OVERLAP_MS).toISOString()
        : undefined;

    // Dedup WITHIN this run only (repeated rows across pages). Cross-run
    // dedup is writeArtifact's job — it is idempotent, and re-writing lets
    // central edits inside the overlap window land locally (central wins).
    const seen = new Set<string>();
    // Echo filter: ONLY this device's own fanout pushes. Desktop notes from
    // other devices are real knowledge and must materialize.
    const ownEchoPrefix = `desktop:${getDeviceId()}:`;
    const writtenFiles: string[] = [];
    let newestCreatedAt = Number.isFinite(watermarkMs) ? watermarkMs : -Infinity;
    let offset = 0;

    // Paginate by offset until a short page ends the stream.
    while (true) {
        const rows = await transport.queryEpisodes({ since, offset, limit: PAGE_LIMIT });
        for (const episode of rows) {
            const createdIso = episodeCreatedAt(episode);
            // Dateless episodes never move the watermark.
            if (createdIso) {
                const createdMs = Date.parse(createdIso);
                if (createdMs > newestCreatedAt) newestCreatedAt = createdMs;
            }
            const id = episodeId(episode);
            if (seen.has(id)) continue;
            seen.add(id);
            if (episode.external_id.startsWith(ownEchoPrefix)) continue;
            const artifact = artifactForEpisode(source, episode);
            const writtenFile = writeArtifact(source, episode, artifact);
            if (writtenFile) {
                writtenFiles.push(writtenFile);
            }
        }
        if (rows.length < PAGE_LIMIT) break;
        offset += rows.length;
    }

    const next: CompanyBrainSourceSyncState = { ...sourceState };
    if (Number.isFinite(newestCreatedAt) && newestCreatedAt > 0) {
        // Clamp to now(): a rogue future created_at must never freeze the
        // pull (since = future - 24h would skip everything real).
        next.lastCreatedAt = new Date(Math.min(newestCreatedAt, Date.now())).toISOString();
    }
    state.sources = { ...(state.sources ?? {}), [source.id]: next };

    return writtenFiles;
}

function recordSourceResult(state: CompanyBrainSyncState, sourceId: string, error?: { kind: string; message: string }): void {
    const previous = state.sources?.[sourceId];
    const now = new Date().toISOString();
    const next: CompanyBrainSourceSyncState = {
        ...previous,
        lastSyncAt: now,
        lastStatus: undefined,
        lastError: undefined,
        backoffMultiplier: undefined,
    };
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

// In-flight guard: concurrent callers (BrainSyncEngine loop + triggerSync)
// share the running sync instead of racing on state/artifacts.
let inFlightSync: Promise<string[]> | null = null;

/**
 * Sync every enabled company_brain source. Optional transport injection for
 * tests; production builds an HttpBrainTransport from the Company Brain
 * config (and skips entirely when the config is disabled or keyless).
 * Concurrent calls join the in-flight run (mutual exclusion).
 */
export function syncCompanyBrainKnowledgeSources(transportOverride?: BrainTransport): Promise<string[]> {
    if (inFlightSync) return inFlightSync;
    inFlightSync = doSyncCompanyBrainKnowledgeSources(transportOverride).finally(() => {
        inFlightSync = null;
    });
    return inFlightSync;
}

async function doSyncCompanyBrainKnowledgeSources(transportOverride?: BrainTransport): Promise<string[]> {
    const state = loadState();
    const sources = knowledgeSourcesRepo
        .listEnabledSources()
        .filter(source => source.provider === 'company_brain' && source.syncMode === 'poll')
        .filter(source => isSourceDue(source, state));

    if (sources.length === 0) return [];

    let transport = transportOverride;
    if (!transport) {
        const config = getCompanyBrainConfig();
        if (!config.enabled || !config.apiKey) {
            console.log('[CompanyBrainKnowledge] Company Brain disabled or missing apiKey; skipping sync');
            return [];
        }
        transport = new HttpBrainTransport(config);
    }

    const run = await serviceLogger.startRun({
        service: 'company_brain',
        message: 'Syncing Company Brain knowledge sources',
        trigger: 'timer',
    });

    const writtenFiles: string[] = [];
    let hadError = false;

    for (const source of sources) {
        let rateLimited = false;
        try {
            const files = await syncSource(source, state, transport);
            writtenFiles.push(...files);
            recordSourceResult(state, source.id);
        } catch (error) {
            // One failing source must not abort the others.
            hadError = true;
            const kind = error instanceof BrainTransportError ? error.kind : 'unknown';
            const message = error instanceof Error ? error.message : String(error);
            recordSourceResult(state, source.id, { kind, message });
            rateLimited = kind === 'rate_limited';
            console.error(`[CompanyBrainKnowledge] Sync failed for source ${source.id} (${kind}):`, message);
            await serviceLogger.log({
                type: 'error',
                service: run.service,
                runId: run.runId,
                level: 'error',
                message: `Company Brain knowledge sync error for source ${source.id} (${kind})`,
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
                message: `Company Brain updates: ${writtenFiles.length} episode artifact${writtenFiles.length === 1 ? '' : 's'}`,
                counts: { episodes: writtenFiles.length },
                items: limitedFiles.items,
                truncated: limitedFiles.truncated,
            });
            await publishCompanyBrainSyncEvent(writtenFiles);
        } catch (error) {
            hadError = true;
            console.error('[CompanyBrainKnowledge] Failed to publish sync results:', error);
        }
    }

    await serviceLogger.log({
        type: 'run_complete',
        service: run.service,
        runId: run.runId,
        level: hadError ? 'error' : 'info',
        message: `Company Brain sync complete: ${writtenFiles.length} artifact${writtenFiles.length === 1 ? '' : 's'}`,
        durationMs: Date.now() - run.startedAt,
        outcome: hadError ? 'error' : 'ok',
        summary: { artifacts: writtenFiles.length },
    });

    return writtenFiles;
}

export function getCompanyBrainArtifactRoot(): string {
    return ARTIFACT_ROOT;
}

export type CompanyBrainSourceStatus = {
    id: string;
    enabled: boolean;
    lastSyncAt?: string;
    lastStatus?: 'ok' | 'error';
    lastError?: { kind: string; message: string };
    /** Pull watermark (max created_at seen). */
    lastCreatedAt?: string;
    /** When the source next becomes due, given interval + backoff. */
    nextDueAt?: string;
};

/** Per-source sync status for the companyBrain:knowledgeStatus IPC channel. */
export function getCompanyBrainSyncStatus(): CompanyBrainSourceStatus[] {
    const state = loadState();
    return knowledgeSourcesRepo
        .getConfig()
        .sources
        .filter(source => source.provider === 'company_brain')
        .map(source => {
            const sourceState = state.sources?.[source.id];
            const lastMs = sourceState?.lastSyncAt ? Date.parse(sourceState.lastSyncAt) : NaN;
            return {
                id: source.id,
                enabled: source.enabled,
                lastSyncAt: sourceState?.lastSyncAt,
                lastStatus: sourceState?.lastStatus,
                lastError: sourceState?.lastError,
                lastCreatedAt: sourceState?.lastCreatedAt,
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
    console.log(`[CompanyBrainKnowledge] Starting Company Brain knowledge sync. Polling every ${DEFAULT_SYNC_INTERVAL_MS / 1000}s`);
    while (true) {
        await syncCompanyBrainKnowledgeSources();
        await interruptibleSleep(DEFAULT_SYNC_INTERVAL_MS);
    }
}
