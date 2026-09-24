# @mcp-orchestrator/core

The orchestration engine and shared contracts. Every other package depends on
`core` and nothing else, so `core` stays transport- and backend-agnostic.

## Install

```bash
npm install @mcp-orchestrator/core
```

## What's inside

- **`Orchestrator`** — composition root. `callTool` is the single pipeline every
  call flows through: allowlist check → `beforeToolCall` hooks (rewrite/veto) →
  audited execution → `afterToolCall` hooks. Optionally delegates to state and
  workflow backends.
- **`ToolRegistry`** — registration, provider-based discovery, validation and
  audited execution. Calls never throw; failures return a failed `ToolResult`.
- **`HookManager`** — typed, event-driven lifecycle bus (`beforeToolCall`,
  `afterToolCall`, `agentSpawn`, `error`).
- **`AgentRegistry`** — declarative agents with per-agent tool allowlists.
- **Audit** — `AuditSink`, `InMemoryAuditSink`, `JsonlAuditSink`.
- **`Result<T, E>`** — errors-as-values helper.

## Structural interfaces

`core` declares the small contracts its peers satisfy, which keeps the dependency
graph one-directional:

- `ToolProvider` — bulk tool discovery (implemented by `@mcp-orchestrator/mcp`).
- `StateAccess` — state get/update (implemented by `@mcp-orchestrator/state`).
- `WorkflowRunner` — workflow execution (implemented by `@mcp-orchestrator/workflow`).

## Quick start

```ts
import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";

const add: ToolDefinition<{ a: number; b: number }, number> = {
  id: "math.add",
  description: "Add two numbers",
  safety: "read-only",
  schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  execute: ({ a, b }) => a + b,
};

const orchestrator = new Orchestrator();
orchestrator.registerTool(add);
orchestrator.onBeforeToolCall((p) => console.log("calling", p.toolId));

const result = await orchestrator.callTool("math.add", { a: 2, b: 3 });
console.log(result.output); // 5
```

See the [API reference](../../docs/api-reference.md#mcp-orchestratorcore) for the
full surface.
