// believe: config for the Be Chat (Mattermost) knowledge connector.
// Pattern: company_brain_config.ts — WorkDir/config/mattermost.json.
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { WorkDir } from './config.js';

const CONFIG_FILE = path.join(WorkDir, 'config', 'mattermost.json');

export const MattermostConfig = z.object({
    /** Base URL of the Mattermost server, e.g. https://chat.believe-global.com */
    url: z.string(),
    /** Personal access token / bot token for the REST API v4. */
    token: z.string(),
    /** Channels to sync: channel ids (26-char) or channel names. */
    channels: z.array(z.string()).default([]),
    /** Team name, required to resolve channels given by name. */
    teamName: z.string().optional(),
});
export type MattermostConfig = z.infer<typeof MattermostConfig>;

/**
 * Read the Mattermost config. Missing or malformed files return null so the
 * connector skips silently when unconfigured.
 */
export function getMattermostConfig(): MattermostConfig | null {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            const parsed = MattermostConfig.safeParse(raw);
            if (parsed.success) return parsed.data;
            console.warn('[MattermostConfig] Invalid mattermost.json, ignoring:', parsed.error.message);
        }
    } catch (err) {
        console.warn('[MattermostConfig] Failed to read mattermost.json:', err);
    }
    return null;
}

/** Persist the Mattermost config (validated, mode 600 — holds the token). */
export function setMattermostConfig(config: MattermostConfig): void {
    const merged = MattermostConfig.parse(config);
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
