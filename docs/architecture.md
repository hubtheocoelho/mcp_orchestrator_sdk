# Architecture

The SDK decomposes a previously monolithic orchestration system into independent,
composable packages. Each layer defines a clear contract and depends only on
`core` (never on its siblings), so any layer can be replaced or extended in
isolation.

## Package graph

```
              ┌───────────────────────┐
              │        core           │  types, Result, tool/agent
              │  (no deps)            │  registries, hooks, orchestrator
              └───────────┬───────────┘
        ┌─────────────┬───┴────┬──────────────┐
        │             │        │              │
   ┌────▼───┐   ┌─────▼───┐ ┌──▼─────┐        │
   │  mcp   │   │  state  │ │workflow│        │
   └────┬───┘   └────┬────┘ └───┬────┘        │
        └────────────┴──────────┴─────► reference-impl / examples
```

`core` knows nothing about MCP transports, persistence backends or workflow YAML.
The other packages depend on `core`'s types and satisfy its **structural**
interfaces (`ToolProvider`, `StateAccess`, `WorkflowRunner`), which is what keeps
the dependency arrows one-directional and avoids cycles.

## Layers

### core

- **Types** — transport/backend-agnostic descriptions of tools, agents, calls and
  results (`types.ts`), plus a `Result<T, E>` helper.
- **ToolRegistry** — registration, provider-based discovery, validation and
  audited execution. Tool calls never throw; failures come back as failed
  `ToolResult`s.
- **HookManager** — a typed, event-driven lifecycle bus. `before*` handlers run
  sequentially and can rewrite params or veto by throwing.
- **AgentRegistry** — declarative agent lifecycle and per-agent tool allowlists.
- **Orchestrator** — the composition root. `callTool` is the single pipeline every
  call flows through: allowlist → `beforeToolCall` → audited execution →
  `afterToolCall`. Optionally delegates to state and workflow backends.

### mcp

Transport-agnostic MCP access. `McpTransport` is the only thing that knows *how* a
server is reached (`InMemoryTransport` ships in-box; stdio/HTTP/WebSocket
transports implement the same interface). `McpClient` implements core's
`ToolProvider`, exposing namespaced tool definitions whose `execute` proxies to
the transport. `McpPool` multiplexes many clients.

### state

Entity-based state with a pluggable `StateBackend` (pure storage) and a
`StateManager` that layers merge-updates, equality queries, naive full-text
search and a reactive layer (`watch`, `onChanged`). `StateManager` satisfies
core's `StateAccess`.

### workflow

Deterministic runtime. `WorkflowDefinition` (Zod-validated) declares steps with
`when`/`stop_when` gates, `on_failure` policies (`fail`/`skip`/`retry`), typed
inputs and named outputs. An eval-free expression engine handles
`${input.x}` / `${steps.id.output}` interpolation and boolean conditions. The
`WorkflowExecutor` runs against any `ToolCaller`; `WorkflowEngine` satisfies
core's `WorkflowRunner`.

### reference-impl

Shows the whole thing assembled: a sandboxed filesystem domain expressed as plain
`ToolDefinition`s and `createReferenceOrchestrator()` wiring core + state +
workflow + audit into one working system.

## Design principles

1. **One-directional dependencies via structural interfaces.** Peripheral packages
   satisfy small interfaces declared in `core`, so `core` never imports them.
2. **Single execution pipeline.** Everything goes through `Orchestrator.callTool`,
   so hooks, allowlists and audit apply uniformly.
3. **Errors as values.** Tool and workflow failures are data (`Result`, failed
   `ToolResult`, `WorkflowResult.error`), not exceptions, at the boundaries.
4. **Deterministic workflows.** No `eval`; interpolation and conditions are a small,
   auditable evaluator.
5. **Observability by default.** Audit sinks capture every tool call and workflow
   lifecycle event as structured (JSONL-friendly) records.
