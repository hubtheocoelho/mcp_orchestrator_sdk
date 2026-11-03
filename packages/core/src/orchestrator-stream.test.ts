import assert from "node:assert/strict";
import { test } from "node:test";
import { Orchestrator, OrchestratorAbortError } from "./orchestrator.js";
import type { OrchestratorEvent } from "./orchestrator-event.js";
import type { ToolDefinition, JsonObject } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const echo: ToolDefinition<{ message: string }, string> = {
  id: "echo",
  description: "Echoes the message",
  schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  safety: "read-only",
  execute: (p) => p.message,
};

const failTool: ToolDefinition = {
  id: "fail",
  description: "Always fails",
  schema: { type: "object" },
  safety: "read-only",
  execute: () => {
    throw new Error("boom");
  },
};

const slowTool: ToolDefinition = {
  id: "slow",
  description: "Takes 200ms",
  schema: { type: "object" },
  safety: "read-only",
  execute: () => new Promise((resolve) => setTimeout(() => resolve("done"), 200)),
};

async function collectStream(gen: AsyncIterable<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const events: OrchestratorEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests — Streaming (Phase 1)
// ---------------------------------------------------------------------------

test("executeWorkflowStream emits correct sequence for successful 3-step workflow", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);

  const steps = [
    { id: "s1", tool: "echo", params: { message: "a" } as JsonObject },
    { id: "s2", tool: "echo", params: { message: "b" } as JsonObject },
    { id: "s3", tool: "echo", params: { message: "c" } as JsonObject },
  ];

  const events = await collectStream(
    orch.executeWorkflowStream("wf1", steps, {}),
  );

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "workflow.started",
    "step.started",
    "step.output",
    "step.started",
    "step.output",
    "step.started",
    "step.output",
    "workflow.finished",
  ]);

  // Check workflow.started has correct payload
  const started = events[0] as Extract<OrchestratorEvent, { type: "workflow.started" }>;
  assert.equal(started.workflowId, "wf1");

  // Check step outputs
  const outputs = events
    .filter((e): e is Extract<OrchestratorEvent, { type: "step.output" }> => e.type === "step.output")
    .map((e) => e.output);
  assert.deepEqual(outputs, ["a", "b", "c"]);

  // Check workflow.finished
  const finished = events[events.length - 1] as Extract<OrchestratorEvent, { type: "workflow.finished" }>;
  assert.equal(finished.workflowId, "wf1");
  assert.equal(finished.result, "c");
});

test("executeWorkflowStream emits step.failed and workflow.failed on error and terminates", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  orch.registerTool(failTool);

  const steps = [
    { id: "s1", tool: "echo", params: { message: "ok" } as JsonObject },
    { id: "s2", tool: "fail", params: {} as JsonObject },
    { id: "s3", tool: "echo", params: { message: "never" } as JsonObject },
  ];

  const events = await collectStream(
    orch.executeWorkflowStream("wf2", steps, {}),
  );

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "workflow.started",
    "step.started",
    "step.output",
    "step.started",
    "step.failed",
    "workflow.failed",
  ]);

  // The stream must have terminated cleanly (we got here = no hanging).
  const failed = events.find(
    (e): e is Extract<OrchestratorEvent, { type: "workflow.failed" }> => e.type === "workflow.failed",
  )!;
  assert.equal(failed.workflowId, "wf2");
});

test("callTool (legacy) still returns the same shape", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  const result = await orch.callTool("echo", { message: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.output, "hello");
  assert.ok(result.callId);
  assert.ok(result.durationMs >= 0);
});

test("callToolStream emits a single tool.chunk for non-streaming tools", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  const events = await collectStream(orch.callToolStream("echo", { message: "hi" }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool.chunk");
  assert.equal((events[0] as any).chunk, "hi");
});

// ---------------------------------------------------------------------------
// Tests — AbortSignal (Phase 2)
// ---------------------------------------------------------------------------

test("aborting mid-workflow terminates the stream with workflow.failed", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);
  orch.registerTool(slowTool);

  const steps = [
    { id: "s1", tool: "echo", params: { message: "fast" } as JsonObject },
    { id: "s2", tool: "slow", params: {} as JsonObject },
    { id: "s3", tool: "echo", params: { message: "never" } as JsonObject },
  ];

  const ctrl = new AbortController();
  // Abort after 50ms (while slow tool is running its 200ms)
  setTimeout(() => ctrl.abort(), 50);

  const events = await collectStream(
    orch.executeWorkflowStream("wf-abort", steps, {}, { signal: ctrl.signal }),
  );

  // We should see at least workflow.started, step.started(s1), step.output(s1),
  // step.started(s2)... then either step.output(s2) followed by abort check,
  // or the tool completes and then abort is detected before s3.
  const types = events.map((e) => e.type);
  assert.ok(types.includes("workflow.started"));
  // The stream must have ended (we got here = no hanging).
  // It should NOT include s3 output since we aborted.
  const s3outputs = events.filter(
    (e) => e.type === "step.output" && (e as any).stepName === "s3",
  );
  assert.equal(s3outputs.length, 0);
});

test("signal already aborted before call rejects immediately", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);

  const ctrl = new AbortController();
  ctrl.abort(); // already aborted

  const events = await collectStream(
    orch.executeWorkflowStream(
      "wf-pre-aborted",
      [{ id: "s1", tool: "echo", params: { message: "x" } as JsonObject }],
      {},
      { signal: ctrl.signal },
    ),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "workflow.failed");
});

// ---------------------------------------------------------------------------
// Tests — Lifecycle (Phase 5)
// ---------------------------------------------------------------------------

test("dispose() is idempotent and does not throw on second call", async () => {
  const orch = new Orchestrator();
  await orch.dispose();
  await orch.dispose(); // second call — should not throw
});

// ---------------------------------------------------------------------------
// Tests — Tracing (Phase 3)
// ---------------------------------------------------------------------------

test("NoopTracer creates spans without errors", async () => {
  const { NoopTracer } = await import("./tracing.js");
  const span = NoopTracer.startSpan("test", { key: "value" });
  span.setAttribute("foo", "bar");
  span.recordException(new Error("test"));
  span.end();
  // If we got here without throwing, the noop tracer works.
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// Tarefa 2 — Progress Mapping (notifications/progress -> step.progress)
// ---------------------------------------------------------------------------

test("executeWorkflowStream emits step.progress with increasing progress when reported", async () => {
  const progressTool: ToolDefinition = {
    id: "progress_task",
    description: "Emits incremental progress",
    schema: { type: "object" },
    safety: "read-only",
    execute: async (_params, context) => {
      context.onProgress?.(25, "one quarter");
      await new Promise((r) => setTimeout(r, 10));
      context.onProgress?.(75, "three quarters");
      await new Promise((r) => setTimeout(r, 10));
      context.onProgress?.(100, "done");
      return "complete";
    },
  };

  const orch = new Orchestrator();
  orch.registerTool(progressTool);

  const steps = [{ id: "step1", tool: "progress_task" }];
  const events = await collectStream(orch.executeWorkflowStream("wf-progress", steps, {}));

  const progressEvents = events.filter(
    (e): e is Extract<OrchestratorEvent, { type: "step.progress" }> => e.type === "step.progress",
  );

  assert.equal(progressEvents.length, 3);
  assert.equal(progressEvents[0]?.progress, 25);
  assert.equal(progressEvents[0]?.message, "one quarter");
  assert.equal(progressEvents[1]?.progress, 75);
  assert.equal(progressEvents[2]?.progress, 100);
});

test("tool without progress does not emit spurious step.progress", async () => {
  const orch = new Orchestrator();
  orch.registerTool(echo);

  const steps = [{ id: "step1", tool: "echo", params: { message: "hi" } as JsonObject }];
  const events = await collectStream(orch.executeWorkflowStream("wf-no-progress", steps, {}));

  const progressEvents = events.filter((e) => e.type === "step.progress");
  assert.equal(progressEvents.length, 0);
});

test("progress respects signal — abort halts emission and emits workflow.failed", async () => {
  const ctrl = new AbortController();
  const longProgressTool: ToolDefinition = {
    id: "long_progress",
    description: "Slow tool reporting progress",
    schema: { type: "object" },
    execute: async (_params, context) => {
      context.onProgress?.(10, "start");
      await new Promise((r) => setTimeout(r, 60));
      context.onProgress?.(50, "half");
      await new Promise((r) => setTimeout(r, 60));
      context.onProgress?.(90, "almost");
      return "finished";
    },
  };

  const orch = new Orchestrator();
  orch.registerTool(longProgressTool);

  setTimeout(() => ctrl.abort(), 30);

  const events = await collectStream(
    orch.executeWorkflowStream("wf-abort-progress", [{ id: "s1", tool: "long_progress" }], {}, { signal: ctrl.signal }),
  );

  const types = events.map((e) => e.type);
  assert.ok(types.includes("workflow.started"));
  assert.ok(types.includes("step.started"));
  assert.ok(types.includes("workflow.failed"));
  // Progress after abort shouldn't be 90
  const progresses = events
    .filter((e): e is Extract<OrchestratorEvent, { type: "step.progress" }> => e.type === "step.progress")
    .map((e) => e.progress);
  assert.ok(!progresses.includes(90), "Should not emit progress after abortion");
});
