# @mcp-orchestrator/state

Entity-based state management with pluggable, reactive backends.

## Install

```bash
npm install @mcp-orchestrator/state @mcp-orchestrator/core
```

## What's inside

- **`StateBackend`** — the pluggable persistence contract (pure storage:
  `get`/`set`/`delete`/`list`/`collections`). Implement it to back state with SQL,
  a document store, a graph, etc.
- **`InMemoryBackend`** — deep-copies on read and write, so callers can never
  mutate stored state by holding a reference.
- **`StateManager`** — layers the higher-level concerns on top of a backend:
  shallow-merge `update`, equality `query`, naive full-text `search`, and a
  reactive layer (`watch` a single entity, `onChanged` for everything). Satisfies
  core's `StateAccess`, so it plugs straight into an `Orchestrator`.

## Quick start

```ts
import { StateManager } from "@mcp-orchestrator/state";

const state = new StateManager(); // defaults to InMemoryBackend

const unsub = state.onChanged((e) => console.log(e.type, e.collection, e.id));

await state.set("users", "1", { id: "1", name: "Theo", role: "dev" });
await state.update("users", "1", { role: "lead" }); // shallow merge

console.log(await state.query("users", { where: { role: "lead" } }));
console.log(await state.search("lead"));

unsub.unsubscribe();
```

## Using it as an orchestrator backend

```ts
import { Orchestrator } from "@mcp-orchestrator/core";
const orchestrator = new Orchestrator({ state: new StateManager() });
await orchestrator.updateState("workspace", "w1", { branch: "main" });
```
