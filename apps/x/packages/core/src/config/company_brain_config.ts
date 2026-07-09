// believe: config for the Company Brain client (pull/push against get-maas EFs).
// Pattern: gmail_sync_config.ts — WorkDir/config/company_brain.json.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { WorkDir } from './config.js';

const CONFIG_FILE = path.join(WorkDir, 'config', 'company_brain.json');

export const DEFAULT_API_URL = 'https://vyllsxqkfefijdbqfgop.supabase.co/functions/v1';
export const DEFAULT_PULL_INTERVAL_MS = 60_000;
export const DEFAULT_PUSH_INTERVAL_MS = 120_000;

export const CompanyBrainConfig = z.object({
    apiUrl: z.string().default(DEFAULT_API_URL),
    apiKey: z.string().optional(),
    enabled: z.boolean().default(false),
    pullIntervalMs: z.number().int().positive().default(DEFAULT_PULL_INTERVAL_MS),
    pushIntervalMs: z.number().int().positive().default(DEFAULT_PUSH_INTERVAL_MS),
    /** Short per-device id (8 hex) namespacing this device's fanout external_ids. */
    deviceId: z.string().optional(),
});
export type CompanyBrainConfig = z.infer<typeof CompanyBrainConfig>;

/**
 * Read the Company Brain config. Missing or malformed files (and any invalid
 * fields) fall back to defaults, with enabled=false so nothing runs
 * unconfigured.
 */
export function getCompanyBrainConfig(): CompanyBrainConfig {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            // Holds the apiKey: tighten permissions even on pre-existing files.
            try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
            const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const parsed = CompanyBrainConfig.safeParse(raw);
            if (parsed.success) return parsed.data;
            console.warn('[CompanyBrainConfig] Invalid company_brain.json, using defaults:', parsed.error.message);
        }
    } catch (err) {
        console.warn('[CompanyBrainConfig] Failed to read company_brain.json:', err);
    }
    return CompanyBrainConfig.parse({});
}

/** Persist the Company Brain config (validated, mode 600 — holds the apiKey). */
export function setCompanyBrainConfig(config: Partial<CompanyBrainConfig>): void {
    const merged = CompanyBrainConfig.parse({ ...getCompanyBrainConfig(), ...config });
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
    // writeFileSync's mode only applies on creation; enforce it on rewrites too.
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort */ }
}

/**
 * Stable per-device id (8 random hex chars), generated once and persisted in
 * company_brain.json. Namespaces this device's fanout external_ids
 * (`desktop:<deviceId>:<relpath>`) so the pull echo filter only discards this
 * device's own pushes — desktop notes from OTHER devices do materialize.
 */
export function getDeviceId(): string {
    const config = getCompanyBrainConfig();
    if (config.deviceId) return config.deviceId;
    const deviceId = crypto.randomBytes(4).toString('hex');
    setCompanyBrainConfig({ deviceId });
    return deviceId;
}
