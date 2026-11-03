import assert from "node:assert/strict";
import { test } from "node:test";
import { Orchestrator } from "@mcp-orchestrator/core";
import { InMemoryBackend } from "./backends/memory.js";
import { StateManager } from "./entity-manager.js";

test("set/get round-trips and get returns a copy", async () => {
  const state = new StateManager();
  await state.set("users", "1", { id: "1", name: "Theo" });
  const got = await state.get("users", "1");
  assert.equal(got?.name, "Theo");
  got!.name = "mutated";
  assert.equal((await state.get("users", "1"))?.name, "Theo");
});

test("update merges a patch and creates when absent", async () => {
  const state = new StateManager();
  await state.set("users", "1", { id: "1", name: "Theo", role: "dev" });
  const merged = await state.update("users", "1", { role: "lead" });
  assert.deepEqual(merged, { id: "1", name: "Theo", role: "lead" });

  const created = await state.update("users", "2", { name: "New" });
  assert.deepEqual(created, { id: "2", name: "New" });
});

test("delete removes and reports existence", async () => {
  const state = new StateManager();
  await state.set("users", "1", { id: "1" });
  assert.equal(await state.delete("users", "1"), true);
  assert.equal(await state.delete("users", "1"), false);
});

test("query filters by equality and limit", async () => {
  const state = new StateManager();
  await state.set("t", "1", { id: "1", kind: "a" });
  await state.set("t", "2", { id: "2", kind: "b" });
  await state.set("t", "3", { id: "3", kind: "a" });
  assert.equal((await state.query("t", { where: { kind: "a" } })).length, 2);
  assert.equal((await state.query("t", { limit: 1 })).length, 1);
});

test("search ranks by number of matching fields", async () => {
  const state = new StateManager();
  await state.set("docs", "1", { id: "1", title: "hello world", body: "world" });
  await state.set("docs", "2", { id: "2", title: "nothing", body: "here" });
  const results = await state.search("world");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.entity.id, "1");
  assert.equal(results[0]?.score, 2);
});

test("onChanged fires for every mutation type", async () => {
  const state = new StateManager();
  const types: string[] = [];
  state.onChanged((e) => types.push(e.type));
  await state.set("t", "1", { id: "1" });
  await state.update("t", "1", { x: 1 });
  await state.delete("t", "1");
  assert.deepEqual(types, ["set", "update", "delete"]);
});

test("watch only fires for the watched entity and can unsubscribe", async () => {
  const state = new StateManager();
  let hits = 0;
  const sub = state.watch("t", "1", () => hits++);
  await state.set("t", "1", { id: "1" });
  await state.set("t", "2", { id: "2" });
  assert.equal(hits, 1);
  sub.unsubscribe();
  await state.set("t", "1", { id: "1", v: 2 });
  assert.equal(hits, 1);
});

test("works as an Orchestrator state backend", async () => {
  const state = new StateManager(new InMemoryBackend());
  const orch = new Orchestrator({ state });
  await orch.updateState("workspace", "w1", { branch: "main" });
  assert.deepEqual(await orch.getState("workspace", "w1"), { id: "w1", branch: "main" });
});

test("dispose clears watchers and is idempotent", async () => {
  const state = new StateManager();
  let called = 0;
  state.watch("items", "i1", () => { called++; });
  await state.dispose();
  await state.dispose(); // idempotent
  await state.set("items", "i1", { id: "i1", val: 1 });
  assert.equal(called, 0);
});
