import assert from "node:assert/strict";
import { test } from "node:test";
import { HookManager } from "./hook-manager.js";

test("handlers run in registration order and receive the payload", async () => {
  const hooks = new HookManager();
  const order: string[] = [];
  hooks.on("beforeToolCall", (p) => {
    order.push(`a:${p.toolId}`);
  });
  hooks.on("beforeToolCall", () => {
    order.push("b");
  });
  await hooks.emit("beforeToolCall", { toolId: "t", caller: "c", params: {} });
  assert.deepEqual(order, ["a:t", "b"]);
});

test("before hooks can mutate params", async () => {
  const hooks = new HookManager();
  hooks.on("beforeToolCall", (p) => {
    p.params.injected = true;
  });
  const payload = { toolId: "t", caller: "c", params: {} as Record<string, unknown> };
  await hooks.emit("beforeToolCall", payload);
  assert.equal(payload.params.injected, true);
});

test("a throwing before hook propagates (veto)", async () => {
  const hooks = new HookManager();
  hooks.on("beforeToolCall", () => {
    throw new Error("blocked by guardrail");
  });
  await assert.rejects(
    () => hooks.emit("beforeToolCall", { toolId: "t", caller: "c", params: {} }),
    /blocked by guardrail/,
  );
});

test("unsubscribe detaches a handler", async () => {
  const hooks = new HookManager();
  let count = 0;
  const sub = hooks.on("agentSpawn", () => {
    count++;
  });
  await hooks.emit("agentSpawn", { config: { id: "a" } });
  sub.unsubscribe();
  await hooks.emit("agentSpawn", { config: { id: "a" } });
  assert.equal(count, 1);
});

test("once fires exactly one time", async () => {
  const hooks = new HookManager();
  let count = 0;
  hooks.once("agentSpawn", () => {
    count++;
  });
  await hooks.emit("agentSpawn", { config: { id: "a" } });
  await hooks.emit("agentSpawn", { config: { id: "a" } });
  assert.equal(count, 1);
});
