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
