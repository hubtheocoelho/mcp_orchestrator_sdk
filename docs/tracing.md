# Observability and Tracing (Runtime 2026)

The MCP Orchestrator SDK provides pluggable, zero-overhead tracing interfaces (`Tracer` and `Span`) without adding any mandatory external dependencies to `@mcp-orchestrator/core`.

## Interface Definition

```typescript
export interface Tracer {
  startSpan(name: string, attributes?: Record<string, unknown>): Span;
}

export interface Span {
  setAttribute(key: string, value: unknown): void;
  recordException(err: unknown): void;
  end(): void;
}

export const NoopTracer: Tracer;
```

By default, the SDK uses `NoopTracer`, ensuring zero runtime cost and zero risk of null reference exceptions when tracing is omitted.

## Emitted Spans

During workflow execution, the runtime generates:
1. **Workflow Span (`workflow.execute`)**: Root span for the execution run.
   - `workflow.id`: Unique workflow identifier
   - `run.id`: Per-run correlation UUID
2. **Step Spans (`workflow.step.<step_id>`)**: Child span for each step.
   - `workflow.id`: Workflow identifier
   - `step.name`: Step ID
   - `tool.name`: Tool being executed
   - `step.status`: `"success" | "failed" | "skipped"`
   - `step.duration_ms`: Duration of the step in milliseconds

## Wiring OpenTelemetry (OTel)

```typescript
import { trace } from "@opentelemetry/api";
import { Orchestrator, type Tracer, type Span } from "@mcp-orchestrator/core";

export class OtelTracer implements Tracer {
  private readonly tracer = trace.getTracer("mcp-orchestrator");

  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const otelSpan = this.tracer.startSpan(name, { attributes: attributes as any });
    return {
      setAttribute(k: string, v: unknown) {
        otelSpan.setAttribute(k, v as any);
      },
      recordException(err: unknown) {
        if (err instanceof Error) otelSpan.recordException(err);
      },
      end() {
        otelSpan.end();
      },
    };
  }
}

// Pass to the Orchestrator
const orchestrator = new Orchestrator({
  tracer: new OtelTracer(),
});
```

The orchestrator forwards its tracer to workflow runs started through
`streamWorkflow` / `executeWorkflowStream`. For runs started directly on the
engine, pass it there too: `new WorkflowEngine({ tools, tracer })`.

## Wiring Langfuse

```typescript
import { Langfuse } from "langfuse";
import { Orchestrator, type Tracer, type Span } from "@mcp-orchestrator/core";

const langfuse = new Langfuse();

export class LangfuseTracer implements Tracer {
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const trace = langfuse.trace({
      name,
      metadata: attributes,
    });
    return {
      setAttribute(k: string, v: unknown) {
        trace.update({ metadata: { [k]: v } });
      },
      recordException(err: unknown) {
        trace.event({ name: "error", metadata: { error: String(err) } });
      },
      end() {
        // Langfuse trace ends on flush or garbage collection
      },
    };
  }
}
```
