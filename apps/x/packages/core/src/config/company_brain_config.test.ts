// believe: tests for the Company Brain config (pattern: sync_slack.test.ts —
// ROWBOAT_WORKDIR must be set before the dynamic import).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-brain-config-test-'));
process.env.ROWBOAT_WORKDIR = tmpWorkDir;

type ConfigModule = typeof import('./company_brain_config.js');
let mod: ConfigModule;

const configFile = path.join(tmpWorkDir, 'config', 'company_brain.json');

beforeAll(async () => {
    mod = await import('./company_brain_config.js');
});

beforeEach(() => {
    fs.rmSync(configFile, { force: true });
});

afterAll(() => {
    fs.rmSync(tmpWorkDir, { recursive: true, force: true });
});

describe('company_brain_config', () => {
    it('returns defaults when the file is missing', () => {
        const config = mod.getCompanyBrainConfig();
        expect(config).toEqual({
            apiUrl: mod.DEFAULT_API_URL,
            enabled: false,
            pullIntervalMs: mod.DEFAULT_PULL_INTERVAL_MS,
            pushIntervalMs: mod.DEFAULT_PUSH_INTERVAL_MS,
        });
    });

    it('round-trips a written config', () => {
        mod.setCompanyBrainConfig({
            apiKey: 'mc_deadbeef_test',
            enabled: true,
            pullIntervalMs: 30_000,
        });
        const config = mod.getCompanyBrainConfig();
        expect(config.apiKey).toBe('mc_deadbeef_test');
        expect(config.enabled).toBe(true);
        expect(config.pullIntervalMs).toBe(30_000);
        expect(config.pushIntervalMs).toBe(mod.DEFAULT_PUSH_INTERVAL_MS);
        expect(config.apiUrl).toBe(mod.DEFAULT_API_URL);
    });

    it('falls back to defaults on malformed JSON', () => {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, '{not json');
        expect(mod.getCompanyBrainConfig().enabled).toBe(false);
    });

    it('falls back to defaults on invalid field types', () => {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify({ pullIntervalMs: 'soon' }));
        expect(mod.getCompanyBrainConfig().pullIntervalMs).toBe(mod.DEFAULT_PULL_INTERVAL_MS);
    });

    it('re-applies chmod 600 when reading a pre-existing config file', () => {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify({ apiKey: 'mc_deadbeef_test' }), { mode: 0o644 });
        mod.getCompanyBrainConfig();
        expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });

    it('re-applies chmod 600 when rewriting an existing config file', () => {
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify({ apiKey: 'mc_deadbeef_test' }), { mode: 0o644 });
        mod.setCompanyBrainConfig({ enabled: true });
        expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    });
});

describe('getDeviceId', () => {
    it('generates an 8-hex deviceId, persists it and returns it stably', () => {
        const first = mod.getDeviceId();
        expect(first).toMatch(/^[0-9a-f]{8}$/);
        // Persisted in the config file...
        const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        expect(onDisk.deviceId).toBe(first);
        // ...and stable across calls.
        expect(mod.getDeviceId()).toBe(first);
    });

    it('respects a deviceId already present in the config', () => {
        mod.setCompanyBrainConfig({ deviceId: 'cafebabe' });
        expect(mod.getDeviceId()).toBe('cafebabe');
    });
});
