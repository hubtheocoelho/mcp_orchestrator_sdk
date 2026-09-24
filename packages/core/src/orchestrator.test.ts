import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAuditSink } from "./audit.js";
import { Orchestrator, ToolNotAllowedError } from "./orchestrator.js";
import type { ToolDefinition } from "./types.js";

const echo: ToolDefinition<{ text: string }, string> = {
  id: "echo",
  description: "echo",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  safety: "read-only",
  execute: (p) => p.text,
};

test("callTool runs before/after hooks around execution", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  const events: string[] = [];
  orch.onBeforeToolCall(() => {
    events.push("before");
  });
  orch.onAfterToolCall((p) => {
    events.push(`after:${p.result.ok}`);
  });
  const result = await orch.callTool("echo", { text: "hi" });
  assert.equal(result.output, "hi");
  assert.deepEqual(events, ["before", "after:true"]);
});

test("before hook can rewrite params", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  orch.onBeforeToolCall((p) => {
    p.params.text = "rewritten";
  });
  const result = await orch.callTool("echo", { text: "original" });
  assert.equal(result.output, "rewritten");
});

test("a vetoing before hook yields a failed result, not a throw", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  orch.onBeforeToolCall(() => {
    throw new Error("denied");
  });
  const result = await orch.callTool("echo", { text: "hi" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "denied");
});

test("agent allowlist blocks disallowed tools", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  await orch.registerAgent({ id: "reader", tools: ["something-else"] });
  const errors: Error[] = [];
  orch.hooks.on("error", (p) => errors.push(p.error));

  const result = await orch.callTool("echo", { text: "hi" }, { caller: "reader" });
  assert.equal(result.ok, false);
  assert.equal(errors[0] instanceof ToolNotAllowedError, true);
});

test("vetoed and disallowed calls still carry a non-empty callId", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  await orch.registerAgent({ id: "reader", tools: ["other"] });

  const disallowed = await orch.callTool("echo", { text: "hi" }, { caller: "reader" });
  assert.ok(disallowed.callId.length > 0);

  const sub = orch.onBeforeToolCall(() => {
    throw new Error("denied");
  });
  const vetoed = await orch.callTool("echo", { text: "hi" }, { callId: "given-id" });
  assert.equal(vetoed.callId, "given-id");
  sub.unsubscribe();
});

test("afterToolCall reports the call's start time, not its end time", async () => {
  const orch = new Orchestrator();
  orch.registerTool({
    id: "slow",
    description: "sleeps",
    schema: { type: "object" },
    execute: () => new Promise((resolve) => setTimeout(() => resolve("done"), 40)),
  });
  let startedAt = 0;
  let endedAt = 0;
  orch.onAfterToolCall((p) => {
    startedAt = p.call.startedAt;
    endedAt = Date.now();
  });
  await orch.callTool("slow", {});
  assert.ok(endedAt - startedAt >= 35, `expected >=35ms, got ${endedAt - startedAt}`);
});

test("agentSpawn hook fires on registerAgent", async () => {
  const orch = new Orchestrator();
  let spawned = "";
  orch.hooks.on("agentSpawn", (p) => {
    spawned = p.config.id;
  });
  await orch.registerAgent({ id: "writer" });
  assert.equal(spawned, "writer");
});

test("delegates workflow execution to the configured runner", async () => {
  const orch = new Orchestrator({
    workflows: { execute: async (id, inputs) => ({ id, inputs }) },
  });
  const out = await orch.executeWorkflow("wf", { a: 1 });
  assert.deepEqual(out, { id: "wf", inputs: { a: 1 } });
});

test("state helpers throw without a backend and delegate with one", async () => {
  const bare = new Orchestrator();
  await assert.rejects(() => bare.getState("c", "1"), /No state backend/);

  const store = new Map<string, unknown>();
  const orch = new Orchestrator({
    state: {
      get: async (c, id) => store.get(`${c}/${id}`),
      update: async (c, id, patch) => void store.set(`${c}/${id}`, patch),
    },
  });
  await orch.updateState("users", "1", { name: "Theo" });
  assert.deepEqual(await orch.getState("users", "1"), { name: "Theo" });
});

test("audit sinks receive orchestrated calls", async () => {
  const sink = new InMemoryAuditSink();
  const orch = new Orchestrator({ auditSinks: [sink] });
  orch.registerTool(echo);
  await orch.callTool("echo", { text: "hi" });
  assert.equal(sink.all().length, 1);
});
