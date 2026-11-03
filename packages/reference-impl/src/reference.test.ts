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
