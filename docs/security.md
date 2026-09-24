# Security model

This page describes which protections the SDK enforces today, which ones it
leaves to you, and its known gaps. Read it before exposing tools to an
autonomous agent.

## What is enforced

| Control | Where | Guarantee |
|---------|-------|-----------|
| Agent tool allowlist | `Orchestrator.callTool` | A call whose `caller` is a **registered** agent can only reach tools in that agent's `tools` list. |
| Hooks and vetoes | `Orchestrator.callTool` | Every `beforeToolCall` handler runs before execution. If one throws, the tool is not executed. |
| Param validation | `ToolRegistry.execute` | Params are validated before `execute` runs. |
| Audit | `ToolRegistry.execute` | Every call that reaches the registry is recorded, including calls that fail validation or reference an unknown tool. Calls blocked by the allowlist or vetoed by a hook stop earlier: they are **not** audited and are reported only through the `error` hook. |
| Filesystem sandbox | `reference-impl` | Paths that resolve outside `baseDir` are rejected. See the limits below. |
| No code evaluation | workflow expressions | Conditions and templates are interpreted without `eval`. |

## What is *not* enforced — your responsibility

### `safety` is metadata only

`read-only`, `write` and `destructive` are labels. Nothing blocks a
`destructive` tool by default. Enforce a policy with a hook; see the guardrail
example in [extending.md](extending.md#hooks-guardrails-and-enrichment).

### The allowlist applies only to registered agents

`callTool` checks the allowlist only when `caller` is the id of a registered
agent. The following callers are **unrestricted**:

- `"system"` (the default when `caller` is omitted);
- **any string that is not a registered agent id, including a typo.**

This is fail-open. Until it changes, don't let untrusted input choose the
`caller` value, and register every agent before routing calls for it. You can
add a fail-closed guard yourself:

```ts
orchestrator.onBeforeToolCall(({ caller }) => {
  if (caller !== "system" && !orchestrator.agents.has(caller)) {
    throw new Error(`Unknown caller: ${caller}`);
  }
});
```

### Only `callTool` is guarded

`orchestrator.tools.execute(...)` is public and bypasses the allowlist and all
hooks. It still validates and audits. Give agents, and code acting for them,
access to `callTool` only. Workflows are safe here, because they call tools
through the `ToolCaller` you pass in, normally the orchestrator.

### Audit records contain full params and outputs

Audit sinks receive raw params and outputs. `JsonlAuditSink` writes them to
`console.log` by default. Redact secrets in a `beforeToolCall` hook or in a
custom sink before persisting.

### MCP responses are untrusted

Tool descriptors and outputs returned by a remote MCP are data from a third
party. Don't treat descriptions or outputs as instructions, and validate
outputs before acting on them.

## Known limitations

- **Filesystem sandbox is lexical.** It compares resolved path strings. It does
  not resolve symlinks, so a symlink inside `baseDir` that points outside it is
  followed. It also rejects legitimate names that begin with `..` (for example
  `..notes`). Don't place untrusted symlinks in the sandbox.
- **Expression paths are not filtered.** `${input.__proto__}` and similar
  segments are read (never written). This exposes no data beyond
  standard object prototypes, but a deny-list is planned.
- **Workflow audit sinks are not isolated.** A throwing sink rejects the run
  (see [workflows.md](workflows.md#audit-trail)).

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainer rather than
in a public issue. Include a minimal reproduction and the affected package
version.
