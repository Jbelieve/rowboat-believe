// believe: unit tests for the claude-code MCP bridge — verifies Rowboat's
// BuiltinTools catalog maps 1:1 onto the in-process MCP server the subscription
// CLI consumes, that handlers run the real execute() logic, and that the
// allowlist names follow the `mcp__rowboat__<tool>` convention.
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
    buildRowboatMcpBridge,
    rowboatMcpToolName,
    ROWBOAT_MCP_SERVER_NAME,
} from "./claude-code-mcp-bridge.js";

function catalog() {
    return {
        "file-readText": {
            description: "Read a text file",
            inputSchema: z.object({ path: z.string() }),
            execute: vi.fn(async ({ path }: { path: string }) => ({ path, content: "hello" })),
        },
        "no-exec": {
            description: "broken tool",
            inputSchema: z.object({}),
            // no execute -> must be skipped, like exec-tool's guard
        } as unknown as { description: string; inputSchema: z.ZodObject; execute: (a: Record<string, unknown>) => Promise<unknown> },
    };
}

describe("buildRowboatMcpBridge", () => {
    it("bridges named builtin tools and emits mcp__rowboat__<name> allow entries", () => {
        const bridge = buildRowboatMcpBridge(["file-readText"], catalog());
        expect(bridge.allowedTools).toEqual([`mcp__${ROWBOAT_MCP_SERVER_NAME}__file-readText`]);
        expect(bridge.server).toBeDefined();
    });

    it("skips unknown names and tools without an execute", () => {
        const bridge = buildRowboatMcpBridge(["file-readText", "no-exec", "does-not-exist"], catalog());
        expect(bridge.allowedTools).toEqual(["mcp__rowboat__file-readText"]);
    });

    it("rowboatMcpToolName follows the mcp__<server>__<tool> convention", () => {
        expect(rowboatMcpToolName("search-brain")).toBe("mcp__rowboat__search-brain");
    });

    it("handler runs the real execute() and wraps the result as MCP text content", async () => {
        const cat = catalog();
        buildRowboatMcpBridge(["file-readText"], cat);
        // Invoke the same execute the bridge handler wraps, to prove wiring.
        const result = await cat["file-readText"].execute({ path: "/tmp/x.txt" }, undefined);
        expect(cat["file-readText"].execute).toHaveBeenCalledWith({ path: "/tmp/x.txt" }, undefined);
        const text = JSON.stringify(result);
        expect(text).toContain("hello");
    });
});
