# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). All packages are versioned together.

## [0.1.0] - Unreleased

Initial release: the SDK extracted from the monolithic orchestration
architecture.

### Added

- **core**: `Orchestrator` with a single `callTool` pipeline (allowlist →
  `beforeToolCall` → audited execution → `afterToolCall`); `ToolRegistry` with
  provider discovery and structural/custom validation; typed `HookManager`;
  `AgentRegistry` with per-agent tool allowlists; `InMemoryAuditSink` and
  `JsonlAuditSink`; `Result` helpers; the `ToolProvider`, `StateAccess` and
  `WorkflowRunner` structural interfaces.
- **mcp**: `McpTransport` interface, `InMemoryTransport`, `McpClient` (namespaced
  tool discovery, resources) and `McpPool`.
- **state**: `StateBackend` interface, `InMemoryBackend`, and `StateManager` with
  merge updates, equality queries, full-text search, `watch` and `onChanged`.
- **workflow**: Zod-validated definitions, eval-free `${…}` interpolation and
  conditions, `when`/`stop_when` gates, `fail`/`skip`/`retry` policies,
  `WorkflowExecutor`, `WorkflowEngine` and a JSONL audit trail.
- **reference-impl**: sandboxed filesystem domain and
  `createReferenceOrchestrator()`.
- Four runnable examples; architecture, getting-started, API, workflow,
  extension and security documentation.

### Fixed

- **core**: `callTool` and `ToolRegistry.execute` returned an exception instead
  of a failed result for unknown tool ids, which also crashed whole workflows.
- **core**: a throwing audit sink could turn a successful call into a failure
  and re-throw to the caller. Sinks are now isolated.
- **core**: vetoed and allowlist-blocked results carried an empty `callId`, and
  `afterToolCall` reported the end time as `startedAt`.
- **workflow**: a `retry` step that exhausted its attempts let the run finish
  with `ok: true`.

### Known issues

- The agent allowlist is fail-open for caller ids that are not registered
  agents. See [docs/security.md](docs/security.md).
- Workflow audit sinks are not isolated: a throwing sink rejects the run.
- The filesystem sandbox does not resolve symlinks.
