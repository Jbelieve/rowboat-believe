// believe: Company Brain sync engine (module 5 of BELIEVE-FORK.md).
// Orchestrates pull (sync_company_brain) + push (fanout) on one loop.
// Pattern: knowledge/granola/sync.ts — while(true) + interruptibleSleep,
// try/catch PER TICK so a bad tick never kills the loop silently.
import { getCompanyBrainConfig } from '../config/company_brain_config.js';
import { syncCompanyBrainKnowledgeSources } from '../knowledge/sources/sync_company_brain.js';
import { EpisodeFanoutProducer } from './fanout.js';
import { HttpBrainTransport } from './transport.js';
import type { BrainTransport } from './transport.js';

export type BrainSyncStatus = {
    lastPullAt?: string;
    lastPushAt?: string;
    lastError?: { phase: 'pull' | 'push'; message: string; at: string };
    /** Total episodes pushed since app start. */
    pushedCount: number;
};

const status: BrainSyncStatus = { pushedCount: 0 };
const fanout = new EpisodeFanoutProducer();

/** Engine status for a future brain:syncStatus IPC channel. */
export function getBrainSyncStatus(): BrainSyncStatus {
    return { ...status };
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

/** One engine pass: pull always, push when pushIntervalMs has elapsed. */
export async function tick(transportOverride?: BrainTransport): Promise<void> {
    const config = getCompanyBrainConfig();
    if (!config.enabled) return;

    try {
        await syncCompanyBrainKnowledgeSources(transportOverride);
        status.lastPullAt = new Date().toISOString();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status.lastError = { phase: 'pull', message, at: new Date().toISOString() };
        console.error('[BrainSync] Pull failed:', message);
    }

    const lastPushMs = status.lastPushAt ? Date.parse(status.lastPushAt) : NaN;
    const pushDue = !Number.isFinite(lastPushMs) || Date.now() - lastPushMs >= config.pushIntervalMs;
    if (!pushDue) return;
    if (!transportOverride && !config.apiKey) return;

    try {
        const transport = transportOverride ?? new HttpBrainTransport(config);
        const result = await fanout.emit(transport);
        status.lastPushAt = new Date().toISOString();
        status.pushedCount += result.pushed;
        if (result.pushed > 0) {
            console.log(`[BrainSync] Pushed ${result.pushed} episode${result.pushed === 1 ? '' : 's'} to the Company Brain`);
        }
    } catch (error) {
        // Fail-soft: fanout marked nothing as processed, so the same notes
        // retry on the next due push.
        const message = error instanceof Error ? error.message : String(error);
        status.lastError = { phase: 'push', message, at: new Date().toISOString() };
        console.error('[BrainSync] Push failed:', message);
    }
}

export async function init(): Promise<void> {
    console.log('[BrainSync] Starting Company Brain sync engine');
    while (true) {
        try {
            await tick();
        } catch (error) {
            // tick() already guards each phase; this is the last-resort net.
            console.error('[BrainSync] Tick failed:', error);
        }
        await interruptibleSleep(getCompanyBrainConfig().pullIntervalMs);
    }
}
