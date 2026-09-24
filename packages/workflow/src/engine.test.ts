import assert from "node:assert/strict";
import { test } from "node:test";
import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";
import { InMemoryWorkflowAuditSink } from "./audit.js";
import { WorkflowEngine, WorkflowNotFoundError } from "./engine.js";
import { WorkflowExecutor, WorkflowInputError } from "./executor.js";

function orchestratorWithTools(...defs: ToolDefinition[]): Orchestrator {
  const orch = new Orchestrator();
  for (const def of defs) orch.registerTool(def);
  return orch;
}

const upper: ToolDefinition<{ text: string }, string> = {
  id: "str.upper",
  description: "uppercase",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: (p) => p.text.toUpperCase(),
};

const exclaim: ToolDefinition<{ text: string }, string> = {
  id: "str.exclaim",
  description: "add !",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: (p) => `${p.text}!`,
};

test("runs steps, threading outputs between them", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(upper, exclaim) });
  engine.define({
    id: "shout",
    inputs: { name: { required: true } },
    steps: [
      { id: "up", tool: "str.upper", params: { text: "${input.name}" } },
      { id: "bang", tool: "str.exclaim", params: { text: "${steps.up.output}" } },
    ],
    outputs: { message: "${steps.bang.output}" },
  });

  const result = await engine.execute("shout", { name: "theo" });
  assert.equal(result.ok, true);
  assert.equal(result.outputs.message, "THEO!");
  assert.equal(result.steps.length, 2);
});

test("validate returns typed errors for a bad definition", () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools() });
  const res = engine.validate({ id: "", steps: [] } as never);
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.error.length > 0);
});

test("missing required input throws WorkflowInputError", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(upper) });
  engine.define({
    id: "needs-input",
    inputs: { name: { required: true } },
    steps: [{ id: "up", tool: "str.upper", params: { text: "${input.name}" } }],
  });
  await assert.rejects(() => engine.execute("needs-input"), WorkflowInputError);
});

test("input defaults are applied", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(upper) });
  engine.define({
    id: "with-default",
    inputs: { name: { default: "world" } },
    steps: [{ id: "up", tool: "str.upper", params: { text: "${input.name}" } }],
    outputs: { out: "${steps.up.output}" },
  });
  const result = await engine.execute("with-default");
  assert.equal(result.outputs.out, "WORLD");
});

test("when-gate skips a step", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(upper) });
  engine.define({
    id: "conditional",
    inputs: { go: { default: false } },
    steps: [{ id: "up", tool: "str.upper", params: { text: "x" }, when: "${input.go} == true" }],
  });
  const result = await engine.execute("conditional", { go: false });
  assert.equal(result.steps[0]?.status, "skipped");
});

test("stop_when halts remaining steps", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(upper, exclaim) });
  engine.define({
    id: "early-stop",
    steps: [
      { id: "up", tool: "str.upper", params: { text: "hi" }, stop_when: "true" },
      { id: "bang", tool: "str.exclaim", params: { text: "never" } },
    ],
  });
  const result = await engine.execute("early-stop");
  assert.equal(result.steps.length, 1);
});

test("on_failure fail stops the run with an error", async () => {
  const boom: ToolDefinition = {
    id: "boom",
    description: "throws",
    schema: { type: "object" },
    execute: () => {
      throw new Error("nope");
    },
  };
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(boom) });
  engine.define({ id: "fails", steps: [{ id: "b", tool: "boom", params: {} }] });
  const result = await engine.execute("fails");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Step "b" failed/);
});

test("on_failure retry re-attempts until success", async () => {
  let calls = 0;
  const flaky: ToolDefinition = {
    id: "flaky",
    description: "fails twice then succeeds",
    schema: { type: "object" },
    execute: () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
  };
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(flaky) });
  engine.define({
    id: "retrying",
    steps: [{ id: "f", tool: "flaky", params: {}, on_failure: "retry", retry: { max: 3 } }],
    outputs: { out: "${steps.f.output}" },
  });
  const result = await engine.execute("retrying");
  assert.equal(result.ok, true);
  assert.equal(result.outputs.out, "ok");
  assert.equal(result.steps[0]?.attempts, 3);
});

test("on_failure retry fails the run once attempts are exhausted", async () => {
  const always: ToolDefinition = {
    id: "always-fails",
    description: "always throws",
    schema: { type: "object" },
    execute: () => {
      throw new Error("permanent");
    },
  };
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(always, upper) });
  engine.define({
    id: "retry-exhausted",
    steps: [
      { id: "a", tool: "always-fails", params: {}, on_failure: "retry", retry: { max: 2 } },
      { id: "b", tool: "str.upper", params: { text: "x" } },
    ],
  });
  const result = await engine.execute("retry-exhausted");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Step "a" failed/);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]?.attempts, 2);
});

test("on_failure skip continues past a failed step", async () => {
  const boom: ToolDefinition = {
    id: "boom",
    description: "throws",
    schema: { type: "object" },
    execute: () => {
      throw new Error("nope");
    },
  };
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(boom, upper) });
  engine.define({
    id: "skip-policy",
    steps: [
      { id: "a", tool: "boom", params: {}, on_failure: "skip" },
      { id: "b", tool: "str.upper", params: { text: "x" } },
    ],
  });
  const result = await engine.execute("skip-policy");
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((s) => s.status), ["failed", "success"]);
});

test("unknown tool in a workflow fails the step instead of throwing", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools() });
  engine.define({ id: "ghost-tool", steps: [{ id: "a", tool: "nope", params: {} }] });
  const result = await engine.execute("ghost-tool");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Tool not found/);
});

test("unknown workflow id throws", async () => {
  const engine = new WorkflowEngine({ tools: orchestratorWithTools() });
  await assert.rejects(() => engine.execute("ghost"), WorkflowNotFoundError);
});

test("audit sink captures the run lifecycle", async () => {
  const sink = new InMemoryWorkflowAuditSink();
  const engine = new WorkflowEngine({ tools: orchestratorWithTools(upper), auditSinks: [sink] });
  engine.define({ id: "audited", steps: [{ id: "up", tool: "str.upper", params: { text: "a" } }] });
  await engine.execute("audited");
  const types = sink.all().map((e) => e.type);
  assert.deepEqual(types, ["run-start", "step-start", "step-complete", "run-complete"]);
});

test("plugs into an Orchestrator as its workflow runner", async () => {
  const orch = orchestratorWithTools(upper);
  const engine = new WorkflowEngine({ tools: orch });
  engine.define({
    id: "via-orch",
    steps: [{ id: "up", tool: "str.upper", params: { text: "hey" } }],
    outputs: { out: "${steps.up.output}" },
  });
  const runner = new Orchestrator({ toolRegistry: orch.tools, workflows: engine });
  const result = (await runner.executeWorkflow("via-orch", {})) as { outputs: { out: string } };
  assert.equal(result.outputs.out, "HEY");
});

test("executor can be used directly with any ToolCaller", async () => {
  const executor = new WorkflowExecutor({
    tools: { callTool: async (_id, params) => ({ ok: true, output: params.text }) },
  });
  const result = await executor.execute(
    { id: "d", description: undefined, inputs: {}, outputs: { o: "${steps.s.output}" }, steps: [{ id: "s", tool: "x", params: { text: "hi" }, on_failure: "fail" }] },
    {},
  );
  assert.equal(result.outputs.o, "hi");
});
