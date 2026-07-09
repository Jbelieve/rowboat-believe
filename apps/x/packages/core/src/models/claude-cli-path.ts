// believe: Resolve the real `claude` CLI executable to hand the claude-code
// provider as `pathToClaudeCodeExecutable`. In the PACKAGED macOS app the Agent
// SDK (@anthropic-ai/claude-agent-sdk, used under ai-sdk-provider-claude-code)
// defaults to a `cli.js` resolved RELATIVE to its own bundle
// (…/Contents/Resources/app/.package/dist/cli.js), which does not exist there —
// producing "Claude Code executable not found at … Is options.pathToClaudeCodeExecutable set?".
// So we must point the provider at the user's actual `claude` binary.
//
// Resolution reuses the canonical cross-platform resolver in
// code-mode/acp/claude-exec.ts (login-shell PATH via `command -v claude`, i.e.
// the same shell-env pattern that fixes GUI-launched Electron PATH stripping,
// plus commonInstallPaths fallbacks). On top of that we add the extra Unix
// fallbacks that commonInstallPaths does not cover — the native installer's
// ~/.claude/local/claude and nvm's versioned bin dirs — so a Finder launch still
// finds claude even when the login-shell probe fails.
import { existsSync, accessSync, constants, readdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveClaudeExecutable } from '../code-mode/acp/claude-exec.js';

let cached: string | undefined;
let probed = false;

function isExecutable(p: string): boolean {
    try {
        accessSync(p, constants.X_OK);
        return true;
    } catch {
        return existsSync(p); // native installer binaries are executable; guard anyway
    }
}

// Extra Unix candidates not covered by commonInstallPaths(): the native
// installer location and every nvm-installed node's bin/claude.
function extraUnixCandidates(): string[] {
    const home = os.homedir();
    const out: string[] = [
        path.join(home, '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
    ];
    const nvmVersions = path.join(home, '.nvm', 'versions', 'node');
    try {
        for (const ver of readdirSync(nvmVersions)) {
            out.push(path.join(nvmVersions, ver, 'bin', 'claude'));
        }
    } catch {
        // no nvm — skip
    }
    return out;
}

// The real `claude` executable to pass as pathToClaudeCodeExecutable, or
// undefined if none is found (callers then omit the option and the provider
// falls back to its own default — preserving today's behavior/error). Result is
// cached; the search is logged once so packaged-app failures are diagnosable.
export function resolveClaudeCodeExecutablePath(): string | undefined {
    if (probed) return cached;
    probed = true;

    // Primary: the canonical resolver (login-shell PATH + commonInstallPaths).
    const primary = resolveClaudeExecutable();
    if (primary && isExecutable(primary)) {
        cached = primary;
        console.log(`[claude-code] resolved claude CLI: ${primary}`);
        return cached;
    }

    // Fallback: native-installer + nvm locations commonInstallPaths misses.
    if (process.platform !== 'win32') {
        const candidates = extraUnixCandidates();
        for (const candidate of candidates) {
            if (existsSync(candidate) && isExecutable(candidate)) {
                cached = candidate;
                console.log(`[claude-code] resolved claude CLI via fallback: ${candidate}`);
                return cached;
            }
        }
        console.warn(
            `[claude-code] could not resolve claude CLI (login-shell PATH + fallbacks all missed): ` +
            `${candidates.join(', ')} — provider will use its bundled default and may fail in the packaged app.`,
        );
    } else {
        console.warn('[claude-code] could not resolve claude CLI on Windows — provider will use its bundled default.');
    }
    return undefined;
}
