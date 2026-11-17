import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { JsonObject } from "@mcp-orchestrator/core";
import { InMemoryCheckpointStore, WorkflowEngine, type ToolCaller } from "@mcp-orchestrator/workflow";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpWorkflowServer, createStreamableHttpHandler, validateInput, type WorkflowToolResult } from "./index.js";

const tools: ToolCaller = {
  async callTool(toolId, params) {
    if (toolId === "greet") return { ok: true, output: { text: `Hello ${String(params.name)}, ${String(params.mood)}` } };
    return { ok: false, error: `no tool ${toolId}` };
  },
};

function makeEngine(): WorkflowEngine {
  const engine = new WorkflowEngine({ tools });
  engine.define({
    id: "greet_user",
    description: "Greets a user after asking their mood",
    inputs: { name: { type: "string", required: true, description: "Who to greet" } },
    steps: [
      {
        id: "ask",
        needs_input: {
          message: "How are you feeling?",
          schema: { type: "object", properties: { mood: { type: "string", enum: ["good", "bad"] } }, required: ["mood"] },
        },
      },
      { id: "say", tool: "greet", params: { name: "${input.name}", mood: "${steps.ask.output.mood}" } },
    ],
    outputs: { text: "${steps.say.output.text}" },
  });
  engine.define({ id: "plain", steps: [{ id: "s", tool: "greet", params: { name: "x", mood: "y" } }] });
  return engine;
}

async function connect(server: McpWorkflowServer, withElicitation?: (params: JsonObject) => unknown) {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: withElicitation ? { elicitation: {} } : {} },
  );
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => withElicitation(req.params as JsonObject) as never);
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return client;
}

const structured = (result: unknown) => (result as { structuredContent: WorkflowToolResult }).structuredContent;

describe("McpWorkflowServer", () => {
  it("lists each workflow as a tool plus the resume tool", async () => {
    const client = await connect(new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine() }));
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name).sort(), ["greet_user", "plain", "resume_workflow"]);
    const greet = listed.find((t) => t.name === "greet_user")!;
    assert.equal(greet.description, "Greets a user after asking their mood");
    assert.deepEqual(greet.inputSchema.required, ["name"]);
  });

  it("filters exposed workflows", async () => {
    const client = await connect(
      new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine(), workflows: ["plain"] }),
    );
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name).sort(), ["plain", "resume_workflow"]);
    await assert.rejects(client.callTool({ name: "greet_user", arguments: { name: "a" } }));
  });

  it("Mode A: elicits input inside the same call", async () => {
    const seen: JsonObject[] = [];
    const client = await connect(new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine() }), (params) => {
      seen.push(params);
      return { action: "accept", content: { mood: "good" } };
    });
    const result = await client.callTool({ name: "greet_user", arguments: { name: "Ana" } });
    assert.deepEqual(structured(result), {
      status: "completed",
      runId: (structured(result) as { runId: string }).runId,
      outputs: { text: "Hello Ana, good" },
    });
    assert.equal(seen[0]?.message, "How are you feeling?");
  });

  it("Mode A: a declined elicitation fails the run", async () => {
    const client = await connect(new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine() }), () => ({
      action: "decline",
    }));
    const result = await client.callTool({ name: "greet_user", arguments: { name: "Ana" } });
    assert.equal(result.isError, true);
    assert.match((structured(result) as { error: string }).error, /declined/);
  });

  it("Mode B: suspends without elicitation and resumes with a single-use token", async () => {
    const checkpoints = new InMemoryCheckpointStore();
    const client = await connect(
      new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine(), checkpointStore: checkpoints }),
    );
    const first = structured(await client.callTool({ name: "greet_user", arguments: { name: "Bo" } }));
    assert.equal(first.status, "suspended");
    if (first.status !== "suspended") return;
    assert.equal(first.request.message, "How are you feeling?");
    assert.ok(await checkpoints.load("greet_user", first.runId));

    // Wrong token and invalid input fail without changing the run.
    const wrong = await client.callTool({
      name: "resume_workflow",
      arguments: { runId: first.runId, resumeToken: "nope", input: { mood: "good" } },
    });
    assert.equal(wrong.isError, true);
    const invalid = await client.callTool({
      name: "resume_workflow",
      arguments: { runId: first.runId, resumeToken: first.resumeToken, input: { mood: "meh" } },
    });
    assert.equal(invalid.isError, true);
    assert.ok(await checkpoints.load("greet_user", first.runId));

    const done = structured(
      await client.callTool({
        name: "resume_workflow",
        arguments: { runId: first.runId, resumeToken: first.resumeToken, input: { mood: "bad" } },
      }),
    );
    assert.deepEqual(done, { status: "completed", runId: first.runId, outputs: { text: "Hello Bo, bad" } });
    assert.equal(await checkpoints.load("greet_user", first.runId), null);

    const replay = await client.callTool({
      name: "resume_workflow",
      arguments: { runId: first.runId, resumeToken: first.resumeToken, input: { mood: "bad" } },
    });
    assert.equal(replay.isError, true);
  });

  it("forcing Mode B on a workflow skips elicitation", async () => {
    let elicited = false;
    const client = await connect(
      new McpWorkflowServer({
        name: "s",
        version: "1",
        engine: makeEngine(),
        workflows: { greet_user: { mode: "suspend" } },
      }),
      () => {
        elicited = true;
        return { action: "accept", content: { mood: "good" } };
      },
    );
    const result = structured(await client.callTool({ name: "greet_user", arguments: { name: "Cy" } }));
    assert.equal(result.status, "suspended");
    assert.equal(elicited, false);
  });

  it("Mode A falls back to suspend when elicitation times out", async () => {
    const client = await connect(
      new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine(), elicitationTimeoutMs: 20 }),
      () => new Promise(() => {}),
    );
    const result = structured(await client.callTool({ name: "greet_user", arguments: { name: "Di" } }));
    assert.equal(result.status, "suspended");
  });

  it("reports missing workflow inputs as a tool error", async () => {
    const client = await connect(new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine() }));
    const result = await client.callTool({ name: "greet_user", arguments: {} });
    assert.equal(result.isError, true);
  });

  it("serves over streamable HTTP", async () => {
    const workflows = new McpWorkflowServer({ name: "s", version: "1", engine: makeEngine() });
    const handler = createStreamableHttpHandler(workflows);
    const http = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    try {
      const client = new Client({ name: "http-client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const result = structured(await client.callTool({ name: "plain", arguments: {} }));
      assert.equal(result.status, "completed");
      await client.close();
    } finally {
      await handler.close();
      await new Promise((resolve) => http.close(resolve));
    }
  });
});

describe("validateInput", () => {
  it("checks required fields, types and enums", () => {
    const schema = {
      type: "object" as const,
      properties: { n: { type: "integer" }, c: { type: "string", enum: ["a"] } },
      required: ["n"],
    };
    assert.deepEqual(validateInput(schema, { n: 1, c: "a" }), []);
    assert.equal(validateInput(schema, { c: "b" }).length, 2);
    assert.equal(validateInput(schema, { n: 1.5 }).length, 1);
    assert.deepEqual(validateInput(schema, []), ["input must be an object"]);
  });
});
