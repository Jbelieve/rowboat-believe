// believe: Tests the out-of-process relay for the claude-code flavor without
// invoking the real Claude provider. A stub runner script speaks the same
// newline-delimited JSON protocol as entry.ts, so we can verify:
//   - the model spawns a clean node child (process.execPath),
//   - it forwards LanguageModelV2CallOptions WITHOUT abortSignal (non-serializable),
//   - it re-emits the runner's stream parts verbatim into doStream,
//   - doGenerate folds text-start/delta/end + finish into the V2 result shape.
// This exercises everything except the real `claude` spawn (which needs the user's
// subscription and only works in the packaged/dev Electron app — the user verifies
// that E2E).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { ClaudeCodeSubprocessModel } from './subprocess-model.js';

// A stub runner: reads the RunnerRequest from stdin, asserts abortSignal is absent,
// echoes the request back (so the test can inspect what crossed the boundary) as a
// text stream, then emits a canned tool-call + finish. Pure node — no deps.
const STUB = `
let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(raw);
  const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
  // Prove the boundary payload: no abortSignal, and callOptions/prompt preserved.
  const hasAbort = 'abortSignal' in (req.callOptions || {});
  send({ kind: 'part', part: { type: 'stream-start', warnings: [] } });
  send({ kind: 'part', part: { type: 'text-start', id: 't1' } });
  send({ kind: 'part', part: { type: 'text-delta', id: 't1',
    delta: JSON.stringify({ model: req.modelId, tools: req.builtinToolNames, hasAbort, prompt: req.callOptions.prompt }) } });
  send({ kind: 'part', part: { type: 'text-end', id: 't1' } });
  send({ kind: 'part', part: { type: 'tool-call', toolCallId: 'c1', toolName: 'file-readText', input: '{}' } });
  send({ kind: 'part', part: { type: 'finish', finishReason: 'tool-calls',
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } } });
  send({ kind: 'done' });
});
`;

// A model wired to run the stub with plain node instead of the real entry.
class StubModel extends ClaudeCodeSubprocessModel {
    private readonly stub: string;
    constructor(modelId: string, tools: string[], stubPath: string) {
        super(modelId, tools);
        this.stub = stubPath;
    }
    protected override entryPath(): string { return this.stub; }
    // process.execPath under vitest is node — keep it.
}

function writeStub(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccrunner-'));
    const p = path.join(dir, 'stub.cjs');
    writeFileSync(p, STUB);
    return p;
}

const callOptions = (): LanguageModelV2CallOptions => ({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    abortSignal: new AbortController().signal,
});

describe('ClaudeCodeSubprocessModel', () => {
    it('is a v2 language model', () => {
        const m = new ClaudeCodeSubprocessModel('sonnet');
        expect(m.specificationVersion).toBe('v2');
        expect(m.modelId).toBe('sonnet');
    });

    it('doStream relays runner parts and strips abortSignal at the boundary', async () => {
        const model = new StubModel('opus', ['file-readText'], writeStub());
        const { stream } = await model.doStream(callOptions());
        const parts: LanguageModelV2StreamPart[] = [];
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
        }
        const types = parts.map((p) => p.type);
        expect(types).toContain('stream-start');
        expect(types).toContain('tool-call');
        expect(types).toContain('finish');

        // The text-delta carries what the runner saw across the boundary.
        const delta = parts.find((p) => p.type === 'text-delta') as { delta: string };
        const seen = JSON.parse(delta.delta);
        expect(seen.model).toBe('opus');
        expect(seen.tools).toEqual(['file-readText']);
        expect(seen.hasAbort).toBe(false); // abortSignal was stripped
        expect(seen.prompt[0].role).toBe('user'); // prompt forwarded verbatim
    });

    it('doGenerate folds text + tool-call + finish into the V2 result', async () => {
        const model = new StubModel('sonnet', [], writeStub());
        const res = await model.doGenerate(callOptions());
        expect(res.finishReason).toBe('tool-calls');
        expect(res.usage.totalTokens).toBe(8);
        const kinds = res.content.map((c) => c.type);
        expect(kinds).toContain('text');
        expect(kinds).toContain('tool-call');
    });

    it('surfaces a runner error as a stream error', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'ccrunner-'));
        const p = path.join(dir, 'boom.cjs');
        writeFileSync(p, `
          let raw=''; process.stdin.on('data',d=>raw+=d);
          process.stdin.on('end', () => {
            process.stdout.write(JSON.stringify({ kind: 'error', message: 'kaboom' }) + '\\n');
          });
        `);
        const model = new StubModel('sonnet', [], p);
        const { stream } = await model.doStream(callOptions());
        const reader = stream.getReader();
        await expect(reader.read()).rejects.toThrow(/kaboom/);
    });
});
