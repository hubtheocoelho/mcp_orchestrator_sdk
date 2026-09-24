# Contributing

## Setup

Requires Node.js ≥ 20.

```bash
npm install
npm run build    # tsc --build (project references, incremental)
npm test         # node:test + tsx over packages/**/*.test.ts
```

Run a single test file:

```bash
node --import tsx --test packages/core/src/orchestrator.test.ts
```

## Repository layout

```
packages/
  core/            orchestration engine and shared contracts (no internal deps)
  mcp/             MCP transports, client, pool          → depends on core
  state/           entity state and backends             → depends on core
  workflow/        workflow schema, expressions, runtime → depends on core
  reference-impl/  assembled example system              → depends on all
examples/          runnable programs
docs/              architecture, guides and reference
```

## Architectural rules

1. **`core` depends on no other workspace package.** `mcp`, `state` and `workflow`
   depend only on `core`, never on each other. When `core` needs to talk to a
   peer, declare a small **structural interface** in `core` (see `ToolProvider`,
   `StateAccess`, `WorkflowRunner`) and have the peer satisfy it.
2. **Errors are values at boundaries.** `callTool`, `ToolRegistry.execute` and
   workflow runs report failure in their result and don't throw. Throw only for
   programmer errors, such as unknown ids in lookup APIs or invalid definitions.
3. **Audit is best-effort.** An audit sink must never change the outcome of the
   operation being audited.
4. **No `eval`.** Keep the expression engine a small interpreter.

## Code conventions

- TypeScript strict mode with `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` and `NodeNext` modules. Use `import type` for type-only
  imports and `.js` extensions in relative imports.
- Tests live next to the code as `*.test.ts` and use `node:test` with
  `node:assert/strict`. Don't add test framework dependencies.
- Every bug fix comes with a regression test that fails without the fix.
- Keep runtime dependencies minimal. Today there is exactly one: `zod`, in
  `workflow`.

## Adding a package

1. Create `packages/<name>/` with `package.json` (named `@mcp-orchestrator/<name>`,
   `"type": "module"`, `exports` pointing at `dist/`) and a `tsconfig.json`
   extending `../../tsconfig.base.json` with `references` to its dependencies.
2. Add `{ "path": "packages/<name>" }` to the root `tsconfig.json` references.
3. Run `npm install` to link the workspace, then `npm run build`.
4. Add a `README.md` and an entry in the root README's package table and
   [`docs/api-reference.md`](docs/api-reference.md).

## Commits

- One logical change per commit. The build and tests must pass at every commit.
- [Conventional Commits](https://www.conventionalcommits.org/) with the package
  as scope: `feat(workflow): …`, `fix(core): …`, `docs: …`, `chore: …`.
- The subject line says *what* changed. The body explains *why*.

## Documentation

Update docs in the same commit as the behavior they describe. TypeScript
snippets in the docs must typecheck against the current packages.
