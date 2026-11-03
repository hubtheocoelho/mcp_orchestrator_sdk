import { Orchestrator, type Tracer, type Span, type ToolDefinition } from "@mcp-orchestrator/core";

/**
 * Custom tracer implementation compatible with OpenTelemetry / Langfuse.
 */
class ConsoleTracer implements Tracer {
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const started = Date.now();
    console.log(`[TRACE] Start span: "${name}"`, attributes);

    return {
      setAttribute(key: string, value: unknown) {
        console.log(`[TRACE] Set attribute [${name}] ${key} = ${JSON.stringify(value)}`);
      },
      recordException(err: unknown) {
        console.error(`[TRACE] Exception in [${name}]:`, err);
      },
      end() {
        console.log(`[TRACE] End span: "${name}" (${Date.now() - started}ms)`);
      },
    };
  }
}

const tool: ToolDefinition<{ val: number }, number> = {
  id: "math.double",
  description: "Doubles input",
  schema: { type: "object", properties: { val: { type: "number" } } },
  execute: (p) => p.val * 2,
};

export async function main(): Promise<void> {
  const tracer = new ConsoleTracer();
  const orchestrator = new Orchestrator({
    // Tracing options passed to the orchestrator
  });

  try {
    orchestrator.registerTool(tool);

    const rootSpan = tracer.startSpan("user.request", { operation: "math.double" });
    const result = await orchestrator.callTool("math.double", { val: 21 });
    rootSpan.setAttribute("result", result.output);
    rootSpan.end();

    console.log("Output:", result.output);
  } finally {
    await orchestrator.dispose();
  }
}

if (process.argv[1]?.endsWith("04-tracing.ts")) {
  main().catch(console.error);
}
