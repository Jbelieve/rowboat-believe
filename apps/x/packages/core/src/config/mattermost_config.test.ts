// believe: tests for the Mattermost config (pattern: company_brain_config.test.ts —
// ROWBOAT_WORKDIR must be set before the dynamic import).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mattermost-config-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;

type ConfigModule = typeof import('./mattermost_config.js');
let mod: ConfigModule;

const configFile = path.join(tmpWorkDir, 'config', 'mattermost.json');

beforeAll(async () => {
    mod = await import('./mattermost_config.js');
});

beforeEach(() => {
    fs.rmSync(configFile, { force: true });
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('mattermost_config permissions', () => {
    it('re-applies chmod 600 when reading a pre-existing config file', () => {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify({ url: 'https://mm.test', token: 't' }), { mode: 0o644 });
        expect(mod.getMattermostConfig()?.url).toBe('https://mm.test');
        expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });

    it('re-applies chmod 600 when rewriting an existing config file', () => {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify({ url: 'https://mm.test', token: 't' }), { mode: 0o644 });
        mod.setMattermostConfig({ url: 'https://mm.test', token: 't2', channels: [] });
        expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });
});
