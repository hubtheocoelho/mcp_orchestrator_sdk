import assert from "node:assert/strict";
import { test } from "node:test";
import { Orchestrator, OrchestratorAbortError, type ToolDefinition } from "@mcp-orchestrator/core";
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

// ---------------------------------------------------------------------------
// Phase 3 — Tracing in WorkflowExecutor
// ---------------------------------------------------------------------------

test("workflow with 3 steps generates exactly 4 spans (1 root + 3 steps), all with end() called", async () => {
  interface RecordedSpan {
    name: string;
    attributes: Record<string, unknown>;
    ended: boolean;
  }
  const spans: RecordedSpan[] = [];

  const fakeTracer = {
    startSpan(name: string, attributes: Record<string, unknown> = {}) {
      const spanRecord: RecordedSpan = { name, attributes: { ...attributes }, ended: false };
      spans.push(spanRecord);
      return {
        setAttribute(k: string, v: unknown) { spanRecord.attributes[k] = v; },
        recordException() {},
        end() { spanRecord.ended = true; },
      };
    },
  };

  const executor = new WorkflowExecutor({
    tools: { callTool: async (_id, params) => ({ ok: true, output: params.text }) },
    tracer: fakeTracer,
  });

  const def = {
    id: "trace-wf",
    inputs: {},
    steps: [
      { id: "s1", tool: "x", params: { text: "1" }, on_failure: "fail" as const },
      { id: "s2", tool: "x", params: { text: "2" }, on_failure: "fail" as const },
      { id: "s3", tool: "x", params: { text: "3" }, on_failure: "fail" as const },
    ],
    outputs: {},
  };

  const result = await executor.execute(def);
  assert.equal(result.ok, true);
  assert.equal(spans.length, 4);
  assert.equal(spans[0]?.name, "workflow.execute");
  assert.equal(spans[1]?.name, "workflow.step.s1");
  assert.equal(spans[2]?.name, "workflow.step.s2");
  assert.equal(spans[3]?.name, "workflow.step.s3");
  assert.ok(spans.every((s) => s.ended));
});

// ---------------------------------------------------------------------------
// Phase 6 — Hardened Runtime: Parallel steps, Checkpoint/Resume, onError
// ---------------------------------------------------------------------------

test("workflow with 2 parallel steps executes in approx max(t1, t2), not sum", async () => {
  const executor = new WorkflowExecutor({
    tools: {
      callTool: async (id, _params) => {
        const delay = id === "slow1" ? 60 : 70;
        await new Promise((r) => setTimeout(r, delay));
        return { ok: true, output: id };
      },
    },
  });

  const start = Date.now();
  const result = await executor.execute({
    id: "parallel-wf",
    inputs: {},
    steps: [
      {
        id: "p-step",
        tool: "slow1",
        parallel: ["slow1", "slow2"],
        params: {},
        on_failure: "fail",
      },
    ],
    outputs: {},
  });

  const elapsed = Date.now() - start;
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps[0]?.output, ["slow1", "slow2"]);
  // If run in series it would take >= 130ms. In parallel it should take < 115ms.
  assert.ok(elapsed < 120, `Expected parallel execution under 120ms, took ${elapsed}ms`);
});

test("parallel steps with sleep(100ms) executes in ~100ms, not 200ms", async () => {
  const executor = new WorkflowExecutor({
    tools: {
      callTool: async (id) => {
        await new Promise((r) => setTimeout(r, 100));
        return { ok: true, output: `${id}_done` };
      },
    },
  });

  const start = Date.now();
  const result = await executor.execute({
    id: "parallel-100",
    inputs: {},
    steps: [
      {
        id: "both",
        tool: "t1",
        parallel: ["t1", "t2"],
        params: {},
        on_failure: "fail",
      },
    ],
    outputs: {},
  });

  const elapsed = Date.now() - start;
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps[0]?.output, ["t1_done", "t2_done"]);
  assert.ok(elapsed < 170, `Expected ~100ms, took ${elapsed}ms`);
});

test("parallel steps with onError: continue delivers final result with failure reported and remaining completed", async () => {
  const executor = new WorkflowExecutor({
    tools: {
      callTool: async (id) => {
        if (id === "fail_tool") return { ok: false, error: "Tool failed" };
        return { ok: true, output: `${id}_success` };
      },
    },
  });

  const result = await executor.execute({
    id: "parallel-continue",
    inputs: {},
    steps: [
      {
        id: "parallel_step",
        tool: "parent",
        parallel: ["good_tool", "fail_tool"],
        params: {},
        onError: "continue",
        on_failure: "fail",
      },
    ],
    outputs: {
      res: "${steps.parallel_step.output}",
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /failed/);
  assert.deepEqual(result.steps[0]?.output, ["good_tool_success", undefined]);
  assert.deepEqual(result.outputs.res, ["good_tool_success", undefined]);
});

test("signal aborts parallel steps and rejects with OrchestratorAbortError", async () => {
  const ctrl = new AbortController();
  const executor = new WorkflowExecutor({
    tools: {
      callTool: async (_id, _params, options) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ ok: true, output: "done" }), 200);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new OrchestratorAbortError());
          });
        });
      },
    },
  });

  setTimeout(() => ctrl.abort(), 20);

  await assert.rejects(
    () =>
      executor.execute(
        {
          id: "parallel-abort",
          inputs: {},
          steps: [
            {
              id: "p_abort",
              tool: "t1",
              parallel: ["t1", "t2"],
              params: {},
              on_failure: "fail",
            },
          ],
          outputs: {},
        },
        {},
        { signal: ctrl.signal },
      ),
    (err: any) => err.name === "OrchestratorAbortError",
  );
});

test("workflow that fails on step 3 can be resumed from step 3 with checkpoint", async () => {
  const { InMemoryCheckpointStore } = await import("./checkpoint.js");
  const checkpointStore = new InMemoryCheckpointStore();
  let step3ShouldFail = true;

  const executor = new WorkflowExecutor({
    tools: {
      callTool: async (id, params) => {
        if (id === "fail3" && step3ShouldFail) {
          return { ok: false, error: "Step 3 transient error" };
        }
        return { ok: true, output: params.val ?? id };
      },
    },
  });

  const def = {
    id: "checkpoint-wf",
    inputs: {},
    steps: [
      { id: "step1", tool: "t1", params: { val: "out1" }, on_failure: "fail" as const },
      { id: "step2", tool: "t2", params: { val: "out2" }, on_failure: "fail" as const },
      { id: "step3", tool: "fail3", params: { val: "out3" }, on_failure: "fail" as const },
      { id: "step4", tool: "t4", params: { val: "out4" }, on_failure: "fail" as const },
    ],
    outputs: {
      s1: "${steps.step1.output}",
      s2: "${steps.step2.output}",
      s3: "${steps.step3.output}",
      s4: "${steps.step4.output}",
    },
  };

  // Run 1: step 3 fails
  const initialResult = await executor.execute(def, {}, { checkpointStore });
  assert.equal(initialResult.ok, false);
  assert.equal(initialResult.steps.length, 3);
  assert.equal(initialResult.steps[2]?.status, "failed");

  // Checkpoint was saved at step 3 index (index 2)
  const savedCp = await checkpointStore.load("checkpoint-wf");
  assert.ok(savedCp);
  assert.equal(savedCp.stepIndex, 2);
  assert.equal((savedCp.state.steps as any).step1?.output, "out1");
  assert.equal((savedCp.state.steps as any).step2?.output, "out2");

  // Run 2: Fix issue and resume
  step3ShouldFail = false;
  const resumedResult = await executor.resume(def, checkpointStore);
  assert.equal(resumedResult.ok, true);
  assert.equal(resumedResult.outputs.s1, "out1");
  assert.equal(resumedResult.outputs.s2, "out2");
  assert.equal(resumedResult.outputs.s3, "out3");
  assert.equal(resumedResult.outputs.s4, "out4");
});

test("onError: 'continue' proceeds and reports failure in final result", async () => {
  const executor = new WorkflowExecutor({
    tools: {
      callTool: async (id, params) => {
        if (id === "fail-tool") return { ok: false, error: "Non-fatal error" };
        return { ok: true, output: params.val ?? "ok" };
      },
    },
  });

  const def = {
    id: "continue-wf",
    inputs: {},
    steps: [
      { id: "s1", tool: "ok-tool", params: { val: "step1" }, onError: "continue" as const, on_failure: "fail" as const },
      { id: "s2", tool: "fail-tool", params: {}, onError: "continue" as const, on_failure: "fail" as const },
      { id: "s3", tool: "ok-tool", params: { val: "step3" }, onError: "continue" as const, on_failure: "fail" as const },
    ],
    outputs: {
      first: "${steps.s1.output}",
      third: "${steps.s3.output}",
    },
  };

  const result = await executor.execute(def);
  // All 3 steps were attempted
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0]?.status, "success");
  assert.equal(result.steps[1]?.status, "failed");
  assert.equal(result.steps[2]?.status, "success");
  // Final workflow result reports failure, but intermediate outputs resolved
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Step "s2" failed/);
  assert.equal(result.outputs.first, "step1");
  assert.equal(result.outputs.third, "step3");
});
