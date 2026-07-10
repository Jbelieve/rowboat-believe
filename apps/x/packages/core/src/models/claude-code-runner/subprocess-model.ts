// believe: A LanguageModelV2 that runs the claude-code (Claude subscription) flavor
// in a CLEAN Electron-as-node SUBPROCESS instead of the Electron main process.
//
// This is the fix for "spawn EBADF" in the packaged macOS app: the Claude Agent SDK
// (under ai-sdk-provider-claude-code) spawns the `claude` binary, and that spawn
// fails reproducibly from the packaged main process but succeeds from a clean node
// subprocess — which is exactly how code-mode/acp runs its engine today. So instead
// of creating the provider in-process, we spawn ./entry.js the same way code-mode
// spawns its ACP adapter (process.execPath + ELECTRON_RUN_AS_NODE=1 + login-shell
// PATH + stdio pipes) and relay the AI SDK's own call options / stream parts across
// the process boundary. The rest of the app is unchanged — streamText drives this
// model exactly like any other LanguageModelV2.
//
// FIDELITY: LanguageModelV2CallOptions is entirely JSON-serializable except
// `abortSignal`, and LanguageModelV2StreamPart is plain JSON. So we forward the
// SDK's already-converted prompt + tool schemas verbatim and re-emit the provider's
// own stream parts verbatim. No re-conversion, no lossy re-mapping.

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
    LanguageModelV2,
    LanguageModelV2CallOptions,
    LanguageModelV2StreamPart,
    LanguageModelV2Content,
    LanguageModelV2FinishReason,
    LanguageModelV2Usage,
} from '@ai-sdk/provider';
import { loginShellPath } from '../../code-mode/acp/shell-env.js';
import { resolveClaudeCodeExecutablePath } from '../claude-cli-path.js';

// Resolve the runner entry to spawn. Two layouts:
//   - DEV (tsc, @x/core unbundled): this module runs from
//     dist/models/claude-code-runner/subprocess-model.js, so entry.js is a sibling.
//   - PACKAGED (esbuild): @x/core is inlined into .package/dist/main.cjs, so
//     import.meta.url is rewritten to that bundle path. The runner is bundled
//     separately (bundle.mjs) to .package/dist/claude-code-runner.cjs — a sibling of
//     main.cjs. We check that first, then fall back to the dev sibling.
function resolveEntryPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const packaged = path.join(here, 'claude-code-runner.cjs'); // sibling of main.cjs
    if (existsSync(packaged)) return packaged;
    return path.join(here, 'entry.js'); // dev: sibling of subprocess-model.js
}

// Build the spawn env: graft the user's login-shell PATH onto process.env so tools
// the `claude` binary itself spawns (git, gh, rg, bash) resolve on a Finder launch,
// and set ELECTRON_RUN_AS_NODE=1 so process.execPath (the Electron binary) behaves
// as plain node. This is the EXACT recipe from code-mode/acp/agents.ts.
function buildSpawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const shellPath = loginShellPath();
    if (shellPath && shellPath !== env.PATH) {
        const dirs = [...shellPath.split(path.delimiter), ...(env.PATH ?? '').split(path.delimiter)];
        env.PATH = [...new Set(dirs.filter(Boolean))].join(path.delimiter);
    }
    env.ELECTRON_RUN_AS_NODE = '1';
    // Surface the Agent SDK's spawn command + claude stderr for diagnosability.
    env.DEBUG_CLAUDE_AGENT_SDK = '1';
    return env;
}

interface RunnerEventPart { kind: 'part'; part: LanguageModelV2StreamPart }
interface RunnerEventError { kind: 'error'; message: string }
interface RunnerEventDone { kind: 'done' }
type RunnerEvent = RunnerEventPart | RunnerEventError | RunnerEventDone;

export class ClaudeCodeSubprocessModel implements LanguageModelV2 {
    readonly specificationVersion = 'v2' as const;
    readonly provider = 'claude-code-subprocess';
    readonly modelId: string;
    readonly supportedUrls: Record<string, RegExp[]> = {};

    // Builtin tool names to bridge over MCP inside the subprocess (claude-code
    // ignores the SDK `tools` option; tools reach it only via settings.mcpServers).
    private readonly builtinToolNames: string[];

    constructor(modelId: string, builtinToolNames: string[] = []) {
        this.modelId = modelId;
        this.builtinToolNames = builtinToolNames;
    }

    // The executable to spawn. process.execPath is the Electron binary in the app
    // (run as node via ELECTRON_RUN_AS_NODE); under vitest/node it is node itself.
    // Overridable so tests can point at a stub runner.
    protected spawnCommand(): string {
        return process.execPath;
    }

    // The runner entry file passed as the first arg. Overridable in tests.
    protected entryPath(): string {
        return resolveEntryPath();
    }

    // Spawn the runner, feed it the request, and return a stream that re-emits the
    // provider's own stream parts. Shared by doStream and doGenerate.
    private runStream(options: LanguageModelV2CallOptions): ReadableStream<LanguageModelV2StreamPart> {
        // Strip abortSignal (non-serializable); process death is our cancel path.
        const { abortSignal, ...serializable } = options;
        const request = {
            modelId: this.modelId,
            builtinToolNames: this.builtinToolNames,
            callOptions: serializable,
            pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
        };

        const command = this.spawnCommand();
        const entry = this.entryPath();
        let child: ChildProcess | undefined;
        let onAbort: (() => void) | undefined;

        return new ReadableStream<LanguageModelV2StreamPart>({
            start(controller) {
                child = spawn(command, [entry], {
                    env: buildSpawnEnv(),
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                let stderrTail = '';
                let errored = false;
                child.stderr?.on('data', (d: Buffer) => {
                    stderrTail = (stderrTail + d.toString()).slice(-4000);
                });

                // Cancel by killing the child — this aborts the CLI turn.
                if (abortSignal) {
                    onAbort = () => { try { child?.kill(); } catch { /* gone */ } };
                    if (abortSignal.aborted) onAbort();
                    else abortSignal.addEventListener('abort', onAbort, { once: true });
                }

                const rl = createInterface({ input: child.stdout! });
                rl.on('line', (line: string) => {
                    const trimmed = line.trim();
                    if (!trimmed) return;
                    let ev: RunnerEvent;
                    try {
                        ev = JSON.parse(trimmed) as RunnerEvent;
                    } catch {
                        // Non-JSON line (a stray log from a dependency). Ignore.
                        return;
                    }
                    if (ev.kind === 'part') {
                        controller.enqueue(ev.part);
                    } else if (ev.kind === 'error') {
                        errored = true;
                        controller.error(new Error(`claude-code runner: ${ev.message}`));
                    } else if (ev.kind === 'done') {
                        errored = true; // prevent the exit handler from double-closing
                        controller.close();
                    }
                });

                child.on('error', (err) => {
                    if (errored) return;
                    errored = true;
                    controller.error(new Error(`claude-code runner spawn failed: ${err.message}`));
                });

                child.on('exit', (code, signal) => {
                    if (errored) return;
                    errored = true;
                    // Exited without a 'done' — surface stderr for diagnosis.
                    controller.error(new Error(
                        `claude-code runner exited (code ${code}${signal ? `, signal ${signal}` : ''})`
                        + (stderrTail.trim() ? ` — ${stderrTail.trim().slice(-1500)}` : ''),
                    ));
                });

                // Send the request and close stdin so the child's readRequest resolves.
                child.stdin!.write(JSON.stringify(request));
                child.stdin!.end();
            },
            cancel() {
                if (onAbort) onAbort();
                try { child?.kill(); } catch { /* already gone */ }
            },
        });
    }

    async doStream(options: LanguageModelV2CallOptions): Promise<{
        stream: ReadableStream<LanguageModelV2StreamPart>;
    }> {
        return { stream: this.runStream(options) };
    }

    // Non-streaming path: consume the stream and fold parts into the doGenerate
    // result shape. The claude-code flavor is used through streamText in the app, so
    // this is mainly for testModelConnection's generateText("ping") and parity.
    async doGenerate(options: LanguageModelV2CallOptions): Promise<{
        content: Array<LanguageModelV2Content>;
        finishReason: LanguageModelV2FinishReason;
        usage: LanguageModelV2Usage;
        warnings: [];
    }> {
        const stream = this.runStream(options);
        const reader = stream.getReader();

        const content: Array<LanguageModelV2Content> = [];
        const textById = new Map<string, string>();
        let finishReason: LanguageModelV2FinishReason = 'stop';
        let usage: LanguageModelV2Usage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const part = value;
            switch (part.type) {
                case 'text-start':
                    textById.set(part.id, '');
                    break;
                case 'text-delta':
                    textById.set(part.id, (textById.get(part.id) ?? '') + part.delta);
                    break;
                case 'text-end': {
                    const text = textById.get(part.id) ?? '';
                    if (text) content.push({ type: 'text', text });
                    textById.delete(part.id);
                    break;
                }
                case 'tool-call':
                    content.push(part);
                    break;
                case 'finish':
                    finishReason = part.finishReason;
                    usage = part.usage;
                    break;
                default:
                    break;
            }
        }
        // Flush any text that never saw an explicit end.
        for (const text of textById.values()) {
            if (text) content.push({ type: 'text', text });
        }

        return { content, finishReason, usage, warnings: [] };
    }
}
