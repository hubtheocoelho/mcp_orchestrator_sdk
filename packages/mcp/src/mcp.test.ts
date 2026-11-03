import assert from "node:assert/strict";
import { test } from "node:test";
import { Orchestrator } from "@mcp-orchestrator/core";
import { McpClient } from "./client.js";
import { McpPool, McpNotFoundError } from "./pool.js";
import { InMemoryTransport } from "./transport.js";

function makeClient(id: string, toolName: string) {
  const transport = new InMemoryTransport({
    tools: [
      {
        name: toolName,
        description: `does ${toolName}`,
        inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        handler: (args) => ({ echoed: args.x }),
      },
    ],
    resources: [{ uri: "mem://greeting", name: "greeting", read: () => "hello" }],
    prompts: [
      {
        name: "summarize",
        description: "Summarizes text",
        arguments: [{ name: "text", required: true }],
        handler: (args) => ({
          messages: [
            {
              role: "user" as const,
              content: { type: "text", text: `Summarize: ${(args as any)?.text ?? ""}` },
            },
          ],
        }),
      },
    ],
  });
  return new McpClient({ id, transport });
}

test("transport rejects calls before start", async () => {
  const t = new InMemoryTransport({ tools: [] });
  await assert.rejects(() => t.listTools(), /not started/);
});

test("client namespaces tool ids and proxies execution", async () => {
  const client = makeClient("calc", "add");
  await client.connect();
  const defs = await client.listToolDefinitions();
  assert.equal(defs[0]?.id, "calc.add");

  const out = await defs[0]?.execute({ x: 5 }, { callId: "c", caller: "system", metadata: {} });
  assert.deepEqual(out, { echoed: 5 });
});

test("client exposes resources", async () => {
  const client = makeClient("calc", "add");
  await client.connect();
  assert.equal((await client.listResources())[0]?.uri, "mem://greeting");
  assert.equal(await client.readResource("mem://greeting"), "hello");
});

test("client calls fail when disconnected", async () => {
  const client = makeClient("calc", "add");
  await assert.rejects(() => client.getTools(), /not connected/);
});

test("pool aggregates definitions and connects all", async () => {
  const pool = new McpPool().add(makeClient("a", "one")).add(makeClient("b", "two"));
  await pool.connectAll();
  const defs = await pool.listToolDefinitions();
  const ids = defs.map((d) => d.id).sort();
  assert.deepEqual(ids, ["a.one", "b.two"]);
  await pool.disconnectAll();
});

test("pool.require throws for unknown ids", () => {
  const pool = new McpPool();
  assert.throws(() => pool.require("nope"), McpNotFoundError);
});

test("orchestrator discovers MCP tools via the client as a ToolProvider", async () => {
  const client = makeClient("calc", "add");
  await client.connect();
  const orch = new Orchestrator();
  await orch.registerToolProvider(client);

  assert.equal(orch.tools.has("calc.add"), true);
  const result = await orch.callTool("calc.add", { x: 7 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, { echoed: 7 });
});

// ---------------------------------------------------------------------------
// Phase 4 — Prompts
// ---------------------------------------------------------------------------

test("client lists prompts from transport", async () => {
  const client = makeClient("ai", "gen");
  await client.connect();
  const prompts = await client.listPrompts();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.name, "summarize");
});

test("client gets a prompt with arguments", async () => {
  const client = makeClient("ai", "gen");
  await client.connect();
  const result = await client.getPrompt("summarize", { text: "hello world" } as any);
  assert.equal(result.messages[0]!.content.text, "Summarize: hello world");
});

// ---------------------------------------------------------------------------
// Phase 4 — Sampling
// ---------------------------------------------------------------------------

test("sampling handler is invoked for sampling requests", async () => {
  const transport = new InMemoryTransport({ tools: [] });
  const client = new McpClient({
    id: "test",
    transport,
    samplingHandler: async (req) => ({
      role: "assistant",
      content: { type: "text", text: `Answered: ${req.messages[0]?.content.text ?? ""}` },
      model: "test-model",
      stopReason: "endTurn",
    }),
  });
  await client.connect();

  const result = await client.handleSamplingRequest({
    messages: [{ role: "user", content: { type: "text", text: "What is 2+2?" } }],
    maxTokens: 100,
  });
  assert.equal(result.content.text, "Answered: What is 2+2?");
  assert.equal(result.model, "test-model");
});

test("sampling request without handler throws", async () => {
  const transport = new InMemoryTransport({ tools: [] });
  const client = new McpClient({ id: "test", transport });
  await client.connect();
  await assert.rejects(
    () => client.handleSamplingRequest({ messages: [], maxTokens: 100 }),
    /no samplingHandler/,
  );
});

// ---------------------------------------------------------------------------
// Phase 4 — Progress
// ---------------------------------------------------------------------------

test("progress notifications are forwarded to handler", async () => {
  const notifications: any[] = [];
  const transport = new InMemoryTransport({ tools: [] });
  const client = new McpClient({
    id: "test",
    transport,
    onProgress: (n) => notifications.push(n),
  });
  await client.connect();

  client.handleProgress({ progressToken: "tok1", progress: 50, total: 100 });
  client.handleProgress({ progressToken: "tok1", progress: 100, total: 100 });

  assert.equal(notifications.length, 2);
  assert.equal(notifications[0]!.progress, 50);
  assert.equal(notifications[1]!.progress, 100);
});

// ---------------------------------------------------------------------------
// Phase 5 — Lifecycle
// ---------------------------------------------------------------------------

test("McpClient dispose is idempotent", async () => {
  const client = makeClient("d", "tool");
  await client.connect();
  await client.dispose();
  await client.dispose(); // second call should not throw
  assert.equal(client.isConnected(), false);
});
