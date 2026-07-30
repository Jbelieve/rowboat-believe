/**
 * Wrapper mínimo sobre la Ingestion API de Langfuse (self-hosted,
 * langfuse.believe-global.com). Fire-and-forget: nunca bloquea ni rompe la
 * respuesta al agente si Langfuse está caído, y es no-op si las env vars
 * (LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY) no están seteadas.
 *
 * Instrumenta el call-site LLM real de apps/cli (Vercel AI SDK):
 * - src/agents/runtime.ts (streamText, loop del agente CLI)
 *
 * Docs: https://langfuse.com/docs/api-and-data-platform/features/public-api
 */

function randomId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function langfuseEnabled(): boolean {
    return Boolean(
        process.env.LANGFUSE_HOST &&
        process.env.LANGFUSE_PUBLIC_KEY &&
        process.env.LANGFUSE_SECRET_KEY,
    );
}

export interface LogGenerationUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

export interface LogGenerationOpts {
    /** Nombre corto del trace/generation (ej. "cli-agent-step"). */
    name: string;
    model: string;
    provider?: string;
    input: unknown;
    output?: unknown;
    usage?: LogGenerationUsage;
    startTime: Date;
    endTime?: Date;
    metadata?: Record<string, unknown>;
    level?: "DEFAULT" | "ERROR";
    statusMessage?: string;
}

/**
 * Registra una generación LLM (trace + generation) en Langfuse vía la
 * Ingestion API. Fire-and-forget: el caller NO debe `await`-earla — cualquier
 * fallo de red o de Langfuse se traga en silencio y nunca frena la corrida real.
 */
export function logGeneration(opts: LogGenerationOpts): void {
    if (!langfuseEnabled()) {
        return;
    }

    const host = process.env.LANGFUSE_HOST as string;
    const auth = Buffer.from(
        `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
    ).toString("base64");

    const traceId = randomId("trace");
    const generationId = randomId("gen");
    const now = new Date().toISOString();
    const startTime = opts.startTime.toISOString();
    const endTime = (opts.endTime ?? new Date()).toISOString();

    const body = {
        batch: [
            {
                id: randomId("evt"),
                type: "trace-create",
                timestamp: now,
                body: {
                    id: traceId,
                    name: opts.name,
                    timestamp: startTime,
                    input: opts.input,
                    output: opts.output,
                    metadata: { app: "rowboat-believe-cli", ...opts.metadata },
                    tags: ["rowboat-believe", "cli"],
                },
            },
            {
                id: randomId("evt"),
                type: "generation-create",
                timestamp: now,
                body: {
                    id: generationId,
                    traceId,
                    name: opts.name,
                    model: opts.model,
                    input: opts.input,
                    output: opts.output,
                    startTime,
                    endTime,
                    usage: opts.usage
                        ? {
                            input: opts.usage.inputTokens,
                            output: opts.usage.outputTokens,
                            total: opts.usage.totalTokens,
                            unit: "TOKENS",
                        }
                        : undefined,
                    metadata: { provider: opts.provider, ...opts.metadata },
                    level: opts.level ?? "DEFAULT",
                    statusMessage: opts.statusMessage,
                },
            },
        ],
    };

    // No await en el caller: dispara y sigue. Cualquier fallo (red, Langfuse
    // caído, timeout) se traga acá — la observabilidad nunca puede tumbar una
    // corrida real.
    void fetch(`${host}/api/public/ingestion`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Basic ${auth}`,
        },
        body: JSON.stringify(body),
    }).catch(() => {
        // no-op: ver comentario arriba.
    });
}
