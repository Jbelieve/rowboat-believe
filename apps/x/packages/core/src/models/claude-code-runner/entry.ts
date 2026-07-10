// believe: Out-of-process runner for the claude-code (Claude subscription) flavor.
//
// WHY THIS FILE EXISTS
// --------------------
// The ai-sdk-provider-claude-code provider runs the Claude Agent SDK, which spawns
// the `claude` binary. When that spawn happens inside Electron's MAIN process of the
// PACKAGED app (launched from Finder/Dock), it throws "spawn EBADF" — reproducibly,
// and independent of fd repair, hardened-runtime entitlements, or stdio tweaks. The
// SAME spawn works fine from a clean Node subprocess, which is exactly how code-mode
// (code-mode/acp) already runs its engine successfully in the packaged app.
//
// So this entry is spawned by the main process as `process.execPath` with
// ELECTRON_RUN_AS_NODE=1 (Electron-as-plain-node) + the login-shell PATH grafted on —
// the EXACT recipe from code-mode/acp/agents.ts. Inside this clean subprocess the
// `claude` spawn succeeds.
//
// PROTOCOL (newline-delimited JSON over stdio)
// --------------------------------------------
//   stdin  (one line):  RunnerRequest  { modelId, builtinToolNames, callOptions, spawnEnvApplied }
//   stdout (many lines): RunnerEvent   { kind: 'part', part } | { kind: 'error', message } | { kind: 'done' }
//
// callOptions is a LanguageModelV2CallOptions with `abortSignal` stripped (non-
// serializable). Everything else — the fully-converted prompt, tools (as JSON
// function schemas), toolChoice, temperature, etc. — is plain JSON, so the fidelity
// is exact: the subprocess reconstructs the real provider model and forwards the
// identical call, then streams the provider's own LanguageModelV2StreamPart objects
// straight back. No message re-conversion, no event re-mapping.
//
// TOOLS: builtinToolNames are bridged into an in-process MCP server HERE (in the
// subprocess), because the claude-code provider only invokes tools via its own
// settings.mcpServers, and the CLI runs its own agentic loop that calls them
// directly. The bridged tools (WorkDir = filesystem, brain = HTTP) are reachable
// from this child just as they are from main. See claude-code-mcp-bridge.ts.

import { createClaudeCode } from 'ai-sdk-provider-claude-code';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import { buildRowboatMcpBridge, ROWBOAT_MCP_SERVER_NAME } from '../claude-code-mcp-bridge.js';

export interface RunnerRequest {
    modelId: string;
    /** Builtin tool names to bridge over MCP (claude-code ignores the SDK `tools`). */
    builtinToolNames: string[];
    /** LanguageModelV2CallOptions with abortSignal stripped. */
    callOptions: Omit<LanguageModelV2CallOptions, 'abortSignal'>;
    /** Absolute path to the real `claude` binary, resolved in main. */
    pathToClaudeCodeExecutable?: string;
}

type RunnerEvent =
    | { kind: 'part'; part: unknown }
    | { kind: 'error'; message: string }
    | { kind: 'done' };

function send(ev: RunnerEvent): void {
    process.stdout.write(JSON.stringify(ev) + '\n');
}

async function readRequest(): Promise<RunnerRequest> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return JSON.parse(raw) as RunnerRequest;
}

async function main(): Promise<void> {
    const req = await readRequest();

    // Build the provider inside the clean subprocess. The `claude` spawn that
    // otherwise EBADFs in the packaged main happens here and succeeds. Env (PATH +
    // DEBUG flag) was already grafted onto process.env by the parent before spawn,
    // so no spawnSettings.env plumbing is needed — the child's process.env IS the
    // grafted env.
    const bridge = req.builtinToolNames.length > 0
        ? buildRowboatMcpBridge(req.builtinToolNames)
        : null;

    const provider = createClaudeCode({
        defaultSettings: {
            ...(req.pathToClaudeCodeExecutable
                ? { pathToClaudeCodeExecutable: req.pathToClaudeCodeExecutable }
                : {}),
            ...(bridge
                ? {
                    mcpServers: { [ROWBOAT_MCP_SERVER_NAME]: bridge.server },
                    allowedTools: bridge.allowedTools,
                    permissionMode: 'bypassPermissions',
                }
                : {}),
        },
    });

    const model = provider.languageModel(req.modelId);

    // Forward the exact converted call. abortSignal is gone (the parent kills this
    // process to cancel), which is fine — process death cancels the CLI turn.
    const { stream } = await model.doStream(
        req.callOptions as unknown as LanguageModelV2CallOptions,
    );

    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        send({ kind: 'part', part: value });
    }
    send({ kind: 'done' });
}

main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
        send({ kind: 'error', message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        process.exit(1);
    });
