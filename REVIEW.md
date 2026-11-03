# MCP Orchestrator SDK — MVP Review

> Generated: 2026-10-07

## Overview

Monorepo TypeScript com 5 packages + examples, zero-dependency externo (exceto Zod no workflow). **Build clean, 69 testes passando, 0 falhas.** A arquitetura é sólida para um MVP.

## Architecture

```
core (types, registries, hooks, orchestrator)
 ├── mcp (transport abstraction, client, pool)
 ├── state (entity CRUD, queries, reactivity)
 ├── workflow (deterministic step executor, expressions)
 └── reference-impl (filesystem domain, wiring example)
```

Dependencies are strictly one-directional via structural interfaces — `core` never imports siblings. This is well-enforced and the composition cycle (orchestrator ↔ workflow engine) is solved cleanly with late binding in `createReferenceOrchestrator`.

## Strengths

1. **Clean separation of concerns.** Each package has a single responsibility with a tight public API. The structural typing approach (e.g. `ToolProvider`, `StateAccess`, `WorkflowRunner`) avoids circular deps without sacrificing composability.

2. **Errors as values at boundaries.** `ToolResult.ok`, `WorkflowResult.ok`, `Result<T,E>` — tool calls never throw to the caller. This is a strong pattern for agent-facing code where unhandled exceptions are dangerous.

3. **Single execution pipeline.** Every tool call goes through `Orchestrator.callTool` → allowlist → beforeHook → validate → execute → audit → afterHook. No bypass path exists for well-behaved consumers.

4. **Expression engine is eval-free.** The `${input.x}` / `${steps.id.output}` interpolation and condition evaluator are safe, small, and auditable. Supports type preservation for full references.

5. **Comprehensive test coverage.** 69 tests cover happy paths, error paths, edge cases (veto hooks, retry exhaustion, sandbox escapes, unknown tools). The tests are well-structured and readable.

6. **Good documentation.** Architecture doc, security model with honest "what's NOT enforced" section, extending guide, API reference, and 4 runnable examples.

## Issues & Risks

### Critical (fix before production use)

1. **Fail-open allowlist.** Any `caller` string that isn't a registered agent ID bypasses the allowlist entirely — including typos. The security doc acknowledges this but the default should be fail-closed. A `beforeToolCall` hook workaround is documented, but this should be a first-class option on Orchestrator (`failOpen: boolean`, defaulting to `false`).

   - File: `packages/core/src/orchestrator.ts:82-87`
   - The check `if (caller !== "system" && this.agents.has(caller))` silently passes unknown callers.

2. **Filesystem sandbox doesn't resolve symlinks.** `safePath` does `relative(root, resolve(path))` — a symlink inside the sandbox pointing outside it will be followed. Documented, but if this SDK is used for agent tooling, symlink resolution (`fs.realpath`) should be added.

   - File: `packages/reference-impl/src/domains/filesystem.ts:16-20`

3. **`__proto__` / constructor pollution in expression paths.** `resolvePath` walks arbitrary dotted paths against a scope object. `${input.__proto__.constructor}` reaches `Object.prototype`. It's read-only and low-severity in practice, but a path segment denylist (`__proto__`, `constructor`, `prototype`) is cheap to add.

   - File: `packages/workflow/src/expression.ts:10-17`

### Important (MVP gaps)

4. **No timeout/cancellation enforcement.** `ToolExecutionContext` carries an `AbortSignal` but nothing enforces it. A tool that ignores the signal can hang the orchestrator indefinitely. The workflow executor passes signals but doesn't race against a timeout. For agent use cases, a configurable per-tool timeout with forced abort would be essential.

   - Affected: `packages/core/src/tool-registry.ts` (execute method), `packages/workflow/src/executor.ts` (runStep method)

5. **`ToolRegistry.execute` bypasses hooks and allowlist.** It's public on `Orchestrator.tools`. Any code with orchestrator access can call `tools.execute()` directly, skipping all guards. Consider making the registry's execute method internal or adding an access control layer.

   - File: `packages/core/src/orchestrator.ts:11` — `readonly tools: ToolRegistry` is public.

6. **Audit gap for blocked calls.** Calls blocked by the allowlist or vetoed by hooks are NOT audited — they only emit an `error` hook event. For compliance/security, you want a record of every attempted call, especially rejected ones. The security doc mentions this explicitly.

   - File: `packages/core/src/orchestrator.ts:78-99`

7. **No Zod validation on tool params.** Despite the README claiming "TypeScript + Zod across the whole pipeline," tool param validation is the minimal `structuralErrors` function checking `required` and `type` only. No `additionalProperties`, `minLength`, `pattern`, `enum`, nested objects, etc. The `validate` callback exists, but most tools won't use it. Consider integrating Zod or Ajv as an optional validator.

   - File: `packages/core/src/tool-registry.ts:138-155` — `structuralErrors` function.

8. **StateManager.search is O(n) full scan.** Naive `JSON.stringify().includes()` over all entities in all collections. Fine for MVP, but flag it for replacement before any non-trivial data volumes.

   - File: `packages/state/src/entity-manager.ts:60-70`

9. **No workflow concurrency.** Steps execute strictly sequentially. A `parallel` step type or DAG-based execution would be a natural next feature for real agent orchestration.

   - File: `packages/workflow/src/executor.ts:44-70` — sequential `for` loop over steps.

### Minor / Polish

10. **`McpPool` doesn't implement `ToolProvider`.** It has `listToolDefinitions()` matching the interface, but the class declaration doesn't say `implements ToolProvider`. Adding it would let `orchestrator.registerToolProvider(pool)` work directly.

    - File: `packages/mcp/src/pool.ts:17`

11. **Workflow audit sinks aren't isolated.** A throwing workflow audit sink rejects the whole run (unlike tool audit sinks which use `Promise.allSettled`). This inconsistency is documented but should be aligned.

    - File: `packages/workflow/src/executor.ts:110` — uses `Promise.all` instead of `Promise.allSettled`.

12. **`deepEqual` via `JSON.stringify`.** Used in `StateManager.query` — it's order-dependent for object keys and doesn't handle `undefined` vs missing keys correctly. Fine for MVP, fragile long-term.

    - File: `packages/state/src/entity-manager.ts:88-90`

13. **No unregisterTool.** `AgentRegistry` has `unregister`, but `ToolRegistry` has no `remove` method. Makes hot-reloading MCP providers harder.

    - File: `packages/core/src/tool-registry.ts`

14. **Examples aren't in scripts.** `package.json` has `"example": "tsx"` but the individual examples use `npm run -w @mcp-orchestrator/examples` in comments without corresponding scripts defined in `examples/package.json`.

    - File: `examples/package.json`

## Code Quality

- Consistent style, good use of TypeScript generics and `readonly`.
- Clean barrel exports via `index.ts` in every package.
- No linter config found (no eslint/biome) — should add one.
- Only dev dependency is `tsx` + `typescript` + `@types/node`. Zod is the sole runtime dep (in workflow). Very lean.

## File Inventory

| Package | Source files | Test files | Lines (approx) |
|---------|-------------|------------|-----------------|
| core | 7 | 4 | ~650 |
| mcp | 4 | 1 | ~280 |
| state | 3 | 1 | ~200 |
| workflow | 6 | 2 | ~500 |
| reference-impl | 2 | 1 | ~120 |
| examples | 4 | 0 | ~150 |

## Priority for Next Iteration

1. Fail-closed allowlist default
2. Tool timeout enforcement
3. Audit for blocked/vetoed calls
4. Linter setup (biome or eslint)
5. Symlink resolution in filesystem sandbox
6. Expression path denylist (`__proto__`, `constructor`, `prototype`)
