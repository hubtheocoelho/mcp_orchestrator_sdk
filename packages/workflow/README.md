# @mcp-orchestrator/workflow

Deterministic workflow runtime with expression interpolation and audit trails.

## Install

```bash
npm install @mcp-orchestrator/workflow @mcp-orchestrator/core
```

## What's inside

- **Zod schemas** — `WorkflowDefinition` declares steps with `when`/`stop_when`
  gates, `on_failure` policies (`fail` / `skip` / `retry`), typed inputs and named
  outputs.
- **Expression engine** — eval-free `${input.x}` / `${steps.id.output}`
  interpolation (type-preserving for full refs, recursive over objects/arrays) and
  boolean condition evaluation with comparisons.
- **`WorkflowExecutor`** — runs a definition against any structural `ToolCaller`
  (core's `Orchestrator` qualifies), applying gates, interpolation and retry.
- **`WorkflowEngine`** — validates, registers and executes named workflows.
  Satisfies core's `WorkflowRunner`.
- **Audit** — `InMemoryWorkflowAuditSink` and `JsonlWorkflowAuditSink` capture the
  run lifecycle (`run-start`, `step-start`, `step-complete`, `run-complete`).

## Quick start

```ts
import { Orchestrator } from "@mcp-orchestrator/core";
import { WorkflowEngine } from "@mcp-orchestrator/workflow";

const orchestrator = new Orchestrator();
// ...register tools like "text.upper" and "text.repeat"...

const engine = new WorkflowEngine({ tools: orchestrator });

engine.define({
  id: "chant",
  inputs: { word: { required: true }, times: { default: 3 } },
  steps: [
    { id: "up", tool: "text.upper", params: { text: "${input.word}" } },
    {
      id: "rep",
      tool: "text.repeat",
      params: { text: "${steps.up.output}", n: "${input.times}" },
      when: "${input.times} > 0",
    },
  ],
  outputs: { chant: "${steps.rep.output}" },
});

const run = await engine.execute("chant", { word: "go" });
console.log(run.outputs.chant); // "GO GO GO"
```

## Failure policies

- `fail` (default) — the step's failure stops the run with `result.error`.
- `skip` — the run continues past a failed step.
- `retry` — re-attempt up to `retry.max` times (with optional `retry.delayMs`).
