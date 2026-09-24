import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentNotFoundError, AgentRegistry, DuplicateAgentError } from "./agent-registry.js";

test("registers and retrieves an agent", () => {
  const registry = new AgentRegistry();
  registry.register({ id: "reader", description: "read-only agent" });
  assert.equal(registry.has("reader"), true);
  assert.equal(registry.get("reader")?.config.description, "read-only agent");
});

test("duplicate registration throws", () => {
  const registry = new AgentRegistry();
  registry.register({ id: "a" });
  assert.throws(() => registry.register({ id: "a" }), DuplicateAgentError);
});

test("upsert replaces an existing agent", () => {
  const registry = new AgentRegistry();
  registry.register({ id: "a", model: "haiku" });
  registry.upsert({ id: "a", model: "opus" });
  assert.equal(registry.get("a")?.config.model, "opus");
});

test("require throws for unknown ids", () => {
  const registry = new AgentRegistry();
  assert.throws(() => registry.require("ghost"), AgentNotFoundError);
});

test("allowedTools returns all tools when no allowlist is set", () => {
  const registry = new AgentRegistry();
  const agent = registry.register({ id: "a" });
  assert.deepEqual(agent.allowedTools(["x", "y"]), ["x", "y"]);
});

test("allowedTools intersects allowlist with existing tools", () => {
  const registry = new AgentRegistry();
  const agent = registry.register({ id: "a", tools: ["x", "z"] });
  assert.deepEqual(agent.allowedTools(["x", "y"]), ["x"]);
});
