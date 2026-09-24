# API reference

A summary of the public surface of each package. Types are exported from each
package's entry point.

## @mcp-orchestrator/core

**Orchestrator** — composition root.

| Member | Signature | Notes |
|--------|-----------|-------|
| `new Orchestrator(options?)` | `{ toolRegistry?, agentRegistry?, hooks?, auditSinks?, state?, workflows? }` | All optional; sensible defaults created. |
| `registerTool(tool, opts?)` | `(ToolDefinition, { source? }) => void` | |
| `registerToolProvider(p)` | `(ToolProvider) => Promise<Tool[]>` | Bulk discovery (e.g. an MCP client). |
| `registerAgent(config)` | `(AgentConfig) => Promise<Agent>` | Emits `agentSpawn`. |
| `callTool(id, params, opts?)` | `=> Promise<ToolResult>` | The single execution pipeline. Never throws. |
| `executeWorkflow(id, inputs, ctx?)` | `=> Promise<unknown>` | Delegates to the configured runner. |
| `getState` / `updateState` | | Delegates to the configured `StateAccess`. |
| `onBeforeToolCall` / `onAfterToolCall` | `=> Subscription` | Hook sugar. |
| `tools` / `agents` / `hooks` | | The underlying registries and bus. |

**ToolRegistry** — `register`, `discover`, `has`, `get`, `list`, `ids`,
`getSchema`, `validate`, `execute`, `audit`.

**AgentRegistry** — `register`, `upsert`, `has`, `get`, `require`, `list`, `ids`,
`unregister`.

**HookManager<Events>** — `on`, `once`, `off`, `emit`, `listenerCount`,
`removeAll`. Standard `HookEventMap`: `beforeToolCall`, `afterToolCall`,
`agentSpawn`, `error`.

**Audit** — `AuditSink`, `AuditRecord`, `InMemoryAuditSink`, `JsonlAuditSink`.

**Result** — `Result<T, E>`, `ok`, `err`, `isOk`, `isErr`, `unwrap`.

**Key types** — `ToolDefinition`, `Tool`, `ToolCall`, `ToolResult`,
`ToolExecutionContext`, `AgentConfig`, `Agent`, `JsonValue`, `JsonObject`,
`JsonSchema`, `ValidationError`, `ToolProvider`, `StateAccess`, `WorkflowRunner`.

## @mcp-orchestrator/mcp

**McpTransport** — `start`, `close`, `listTools`, `callTool`, optional
`listResources` / `readResource`. `InMemoryTransport` is a ready in-process
implementation.

**McpClient** — `connect`, `disconnect`, `isConnected`, `getTools`, `callTool`,
`listResources`, `readResource`, `listToolDefinitions` (implements
`ToolProvider`). Tool ids are namespaced `${clientId}.${toolName}` by default.

**McpPool** — `add`, `remove`, `get`, `require`, `ids`, `connectAll`,
`disconnectAll`, `listToolDefinitions`, `callTool`.

## @mcp-orchestrator/state

**StateManager(backend?)** — `get`, `set`, `update` (shallow merge), `delete`,
`query(collection, { where?, limit? })`, `search(text)`, `watch`, `onChanged`.
Satisfies core's `StateAccess`.

**StateBackend** — `get`, `set`, `delete`, `list`, `collections`.
`InMemoryBackend` deep-copies on read/write.

**Types** — `Entity`, `EntityQuery`, `SearchResult`, `StateChangeEvent`.

## @mcp-orchestrator/workflow

**WorkflowEngine({ tools, auditSinks? })** — `define`, `validate` (returns
`Result`), `has`, `get`, `list`, `execute`. Satisfies core's `WorkflowRunner`.

**WorkflowExecutor({ tools, auditSinks? })** — `execute(definition, inputs, ctx?)`
for running a definition without registering it.

**Expression engine** — `interpolate`, `interpolateParams`, `resolvePath`,
`evaluateCondition`.

**Schema/types** — `workflowDefinitionSchema` (Zod), `WorkflowDefinition`,
`WorkflowStep`, `WorkflowResult`, `StepResult`, `ToolCaller`, `ExecutionContext`,
`OnFailure`, `RetryConfig`.

**Audit** — `WorkflowAuditSink`, `WorkflowAuditEvent`,
`InMemoryWorkflowAuditSink`, `JsonlWorkflowAuditSink`.

## @mcp-orchestrator/reference-impl

**`filesystemDomain(baseDir)`** — returns sandboxed `ToolDefinition[]`
(`filesystem.read_file`, `filesystem.write_file`, `filesystem.list_files`).

**`createReferenceOrchestrator({ filesystemRoot? })`** — returns
`{ orchestrator, state, workflows, toolAudit, workflowAudit }`.
