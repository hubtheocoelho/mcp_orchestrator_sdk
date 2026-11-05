import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createReferenceOrchestrator } from "./index.js";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-ref-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("filesystem tools are sandboxed", async () => {
  const { orchestrator } = createReferenceOrchestrator({ filesystemRoot: root });
  const escape = await orchestrator.callTool("filesystem.read_file", { path: "../../etc/hosts" });
  assert.equal(escape.ok, false);
  assert.match(escape.error ?? "", /escapes sandbox/);
});

test("a workflow writes then reads a file end to end", async () => {
  const { orchestrator, workflows, workflowAudit } = createReferenceOrchestrator({
    filesystemRoot: root,
  });

  workflows.define({
    id: "write-then-read",
    inputs: { filename: { required: true }, body: { required: true } },
    steps: [
      {
        id: "write",
        tool: "filesystem.write_file",
        params: { path: "${input.filename}", content: "${input.body}" },
      },
      {
        id: "read",
        tool: "filesystem.read_file",
        params: { path: "${input.filename}" },
      },
    ],
    outputs: { contents: "${steps.read.output}", bytes: "${steps.write.output.bytes}" },
  });

  const result = await orchestrator.executeWorkflow("write-then-read", {
    filename: "note.txt",
    body: "hello sdk",
  });

  const typed = result as { ok: boolean; outputs: { contents: string; bytes: number } };
  assert.equal(typed.ok, true);
  assert.equal(typed.outputs.contents, "hello sdk");
  assert.equal(typed.outputs.bytes, 9);

  // The file really exists on disk.
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "hello sdk");
  // Both the tool audit and workflow audit captured the run.
  assert.ok(workflowAudit.all().some((e) => e.type === "run-complete"));
});

test("tool calls are audited through the assembled orchestrator", async () => {
  const { orchestrator, toolAudit } = createReferenceOrchestrator({ filesystemRoot: root });
  await orchestrator.callTool("filesystem.list_files", {});
  assert.equal(toolAudit.all().length, 1);
  assert.equal(toolAudit.all()[0]?.call.toolId, "filesystem.list_files");
});

test("runHarness executes successfully with streaming and dispose", async () => {
  const { runHarness } = await import("./harness.js");
  await assert.doesNotReject(() => runHarness({ filesystemRoot: root }));
});

test("executeWorkflowStream runs inline steps with full workflow semantics via the engine", async () => {
  const { orchestrator } = createReferenceOrchestrator({ filesystemRoot: root });
  const events = [];
  for await (const event of orchestrator.executeWorkflowStream(
    "stream-semantics",
    [
      { id: "write", tool: "filesystem.write_file", params: { path: "s.txt", content: "${input.text}" } },
      { id: "skipped", tool: "filesystem.read_file", params: { path: "missing.txt" }, when: "${input.never}" },
      { id: "read", tool: "filesystem.read_file", params: { path: "s.txt" } },
    ],
    { text: "interpolated", never: false },
  )) {
    events.push(event);
  }

  const started = events.filter((e) => e.type === "step.started").map((e) => (e as { stepName: string }).stepName);
  assert.deepEqual(started, ["write", "read"], "`when` gate is honored");
  const last = events.at(-1);
  assert.equal(last?.type, "workflow.finished");
  assert.match(JSON.stringify((last as { result: unknown }).result), /interpolated/);
});

test("streamWorkflow streams a registered workflow", async () => {
  const { orchestrator, workflows } = createReferenceOrchestrator({ filesystemRoot: root });
  workflows.define({
    id: "registered-stream",
    inputs: { text: { type: "string", required: true } },
    steps: [{ id: "w", tool: "filesystem.write_file", params: { path: "r.txt", content: "${input.text}" } }],
    outputs: { done: "yes" },
  });

  const types = [];
  let finished: unknown;
  for await (const event of orchestrator.streamWorkflow("registered-stream", { text: "x" })) {
    types.push(event.type);
    if (event.type === "workflow.finished") finished = event.result;
  }
  assert.deepEqual(types, ["workflow.started", "step.started", "step.output", "workflow.finished"]);
  assert.deepEqual(finished, { done: "yes" });
});
