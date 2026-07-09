// believe: Bridge Rowboat's BuiltinTools catalog into an in-process MCP server so
// the Claude *subscription* (via the `claude` CLI / Agent SDK, flavor
// "claude-code") can invoke them. The claude-code provider ignores the AI SDK
// `tools` option entirely — it only reads its own `settings.mcpServers` and
// `settings.allowedTools`, and the CLI runs its OWN internal agentic loop that
// calls MCP tools directly. So MCP is the only channel to give the subscription
// model Rowboat's tools, and the tool handler must run the SAME
// BuiltinTools[name].execute logic in-process.
//
// Shape match: createCustomMcpServer expects
//   { name, tools: { [toolName]: { description, inputSchema: ZodObject, handler } } }
// and passes inputSchema.shape to the Agent SDK `tool()`. Rowboat's BuiltinTools
// entries are { description, inputSchema: ZodObject, execute } — a 1:1 map.
import { createCustomMcpServer } from "ai-sdk-provider-claude-code";
import type { ZodObject, ZodRawShape } from "zod";
import { BuiltinTools } from "../application/lib/builtin-tools.js";
import type { ToolContext } from "../application/lib/exec-tool.js";

// The MCP server name under which Rowboat tools are exposed. Allow/deny names
// are `mcp__<SERVER_NAME>__<toolName>`.
export const ROWBOAT_MCP_SERVER_NAME = "rowboat";

export function rowboatMcpToolName(toolName: string): string {
    return `mcp__${ROWBOAT_MCP_SERVER_NAME}__${toolName}`;
}

// A minimal view of a BuiltinTools entry — enough to bridge. Kept structural so
// it also accepts a test-supplied subset of the catalog.
interface BridgeableTool {
    description: string;
    inputSchema: ZodObject<ZodRawShape>;
    execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
    isAvailable?: () => Promise<boolean>;
}

export interface RowboatMcpBridge {
    /** Server config to pass under createClaudeCode settings.mcpServers[ROWBOAT_MCP_SERVER_NAME]. */
    server: ReturnType<typeof createCustomMcpServer>;
    /** allowedTools entries (`mcp__rowboat__<name>`) for the tools that were bridged. */
    allowedTools: string[];
}

// Build an in-process MCP server exposing the given tool names from a
// BuiltinTools-shaped catalog. Unknown names and tools without an `execute` are
// skipped (mirrors exec-tool's guard). The handler wraps the raw Rowboat result
// as MCP text content — the CLI relays it back to the model verbatim.
//
// `ctx` is passed through to execute() when provided. Note: the CLI drives its
// own loop, so a full turn-scoped ToolContext (abort registry, publish channel)
// isn't wired here yet — tools that require it degrade rather than crash.
export function buildRowboatMcpBridge(
    toolNames: string[],
    catalog: Record<string, BridgeableTool> = BuiltinTools as unknown as Record<string, BridgeableTool>,
    ctx?: ToolContext,
): RowboatMcpBridge {
    const tools: Record<string, {
        description: string;
        inputSchema: ZodObject<ZodRawShape>;
        handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
    }> = {};
    const allowedTools: string[] = [];

    for (const name of toolNames) {
        const def = catalog[name];
        if (!def || typeof def.execute !== "function") continue;
        tools[name] = {
            description: def.description,
            inputSchema: def.inputSchema,
            handler: async (args) => {
                const result = await def.execute(args, ctx);
                const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
                return { content: [{ type: "text", text }] };
            },
        };
        allowedTools.push(rowboatMcpToolName(name));
    }

    const server = createCustomMcpServer({
        name: ROWBOAT_MCP_SERVER_NAME,
        version: "1.0.0",
        tools,
    });

    return { server, allowedTools };
}
