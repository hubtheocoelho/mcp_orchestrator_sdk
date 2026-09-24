import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryAuditSink } from "./audit.js";
import { ToolNotFoundError, ToolRegistry, type ToolProvider } from "./tool-registry.js";
import type { ToolDefinition } from "./types.js";

const echo: ToolDefinition<{ text: string }, string> = {
  id: "test.echo",
  description: "Echoes the given text",
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  safety: "read-only",
  execute: (params) => params.text,
};

test("registers and lists tools with a source", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  assert.equal(registry.has("test.echo"), true);
  const tool = registry.get("test.echo");
  assert.equal(tool?.source, "local");
  assert.equal(tool?.safety, "read-only");
});

test("validate reports missing required fields", () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const result = registry.validate("test.echo", {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error[0]?.path, "text");
});

test("execute runs the tool and audits the call", async () => {
  const sink = new InMemoryAuditSink();
  const registry = new ToolRegistry({ auditSinks: [sink] });
  registry.register(echo);

  const result = await registry.execute("test.echo", { text: "hi" }, { caller: "agent-1" });
  assert.equal(result.ok, true);
  assert.equal(result.output, "hi");
  assert.equal(sink.all().length, 1);
  assert.equal(sink.all()[0]?.call.caller, "agent-1");
});

test("execute returns a failed result on validation error without throwing", async () => {
  const registry = new ToolRegistry();
  registry.register(echo);
  const result = await registry.execute("test.echo", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Validation failed/);
});

test("execute captures thrown errors as failed results", async () => {
  const registry = new ToolRegistry();
  registry.register({
    id: "test.boom",
    description: "throws",
    schema: { type: "object" },
    execute: () => {
      throw new Error("kaboom");
    },
  });
  const result = await registry.execute("test.boom", {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "kaboom");
});

test("discover registers every tool from a provider", async () => {
  const registry = new ToolRegistry();
  const provider: ToolProvider = {
    id: "mcp-x",
    listToolDefinitions: () => [echo],
  };
  const tools = await registry.discover(provider);
  assert.equal(tools.length, 1);
  assert.equal(registry.get("test.echo")?.source, "mcp-x");
});

test("execute returns a failed, audited result for an unknown tool instead of throwing", async () => {
  const sink = new InMemoryAuditSink();
  const registry = new ToolRegistry({ auditSinks: [sink] });
  const result = await registry.execute("nope", {});
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Tool not found: nope/);
  assert.equal(sink.all().length, 1);
});

test("unknown tool ids throw ToolNotFoundError", () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.getSchema("nope"), ToolNotFoundError);
});
