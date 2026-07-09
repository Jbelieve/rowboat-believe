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
import { loginShellPath } from '../code-mode/acp/shell-env.js';

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

// believe: Settings that let the Agent SDK spawn `claude` from the PACKAGED app
// launched via Finder/Dock. Two failure modes are fixed here, mirroring what the
// ACP code-mode engine (code-mode/acp/agents.ts) already does and which the user
// confirmed works in the packaged app:
//
//  1. "spawn EBADF". The Agent SDK's spawnLocalProcess uses
//     `stdio: ['pipe','pipe', DEBUG_CLAUDE_AGENT_SDK || options.stderr ? 'pipe' : 'ignore']`.
//     A GUI (Finder/Dock) launch gives the Electron process no valid stdio fds, so
//     the child's stderr `'ignore'` (which dup2's /dev/null onto a broken fd 2)
//     throws EBADF at libuv. Forcing stderr to `'pipe'` avoids the broken fd. We
//     flip it two ways: set DEBUG_CLAUDE_AGENT_SDK=1 in the child env AND pass an
//     `stderr` callback — either alone makes the SDK use `'pipe'`; we do both so a
//     regression in one path still leaves the fd valid, and the callback captures
//     claude's stderr for diagnosis. In dev (terminal launch) fds are valid, so
//     this is a no-op there.
//  2. Stripped PATH. GUI launches inherit launchd's minimal PATH, so tools `claude`
//     itself spawns (git, gh, rg, bash) fail with "command not found". Graft the
//     login-shell PATH onto the child env, exactly as the ACP engine does.
//
// Note: `pathToClaudeCodeExecutable` points the SDK at the user's real `claude`
// (a node shebang script with no extension). The SDK spawns it directly (its C6
// extension check treats a no-extension path as a native executable), so we do NOT
// need ELECTRON_RUN_AS_NODE here — that only matters when the interpreter is
// process.execPath (Electron), which is the ACP engine's case, not this one.
export function claudeCodeSpawnSettings(): { env: Record<string, string | undefined>; stderr: (data: string) => void } {
    const env: Record<string, string | undefined> = { ...process.env };

    const shellPath = loginShellPath();
    if (shellPath && shellPath !== env.PATH) {
        const dirs = [...shellPath.split(path.delimiter), ...(env.PATH ?? '').split(path.delimiter)];
        env.PATH = [...new Set(dirs.filter(Boolean))].join(path.delimiter);
    }

    // Forces the SDK's child stderr from 'ignore' to 'pipe' (see failure mode 1).
    env.DEBUG_CLAUDE_AGENT_SDK = '1';

    return {
        env,
        stderr: (data: string) => {
            // Surface claude's own stderr so packaged-app spawn/auth failures are
            // diagnosable. Trim to avoid flooding logs.
            const line = data.toString().trimEnd();
            if (line) console.error(`[claude-code] ${line.slice(0, 2000)}`);
        },
    };
}
