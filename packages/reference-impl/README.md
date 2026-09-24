# @mcp-orchestrator/reference-impl

A reference showing how the SDK's independent packages compose into one working
system. Use it as a template for your own assembly, or as an integration test of
the whole stack.

## What's inside

- **`filesystemDomain(baseDir)`** — a small filesystem domain
  (`filesystem.read_file`, `filesystem.write_file`, `filesystem.list_files`)
  exposed as plain `ToolDefinition`s and **sandboxed** to `baseDir`: every path is
  resolved against the base and rejected if it escapes it. This mirrors how the
  original monolith's filesystem tools become registrable SDK tools.
- **`createReferenceOrchestrator({ filesystemRoot? })`** — wires `core` + `state`
  + `workflow` + audit into one object:
  `{ orchestrator, state, workflows, toolAudit, workflowAudit }`. The workflow
  engine uses the orchestrator as its tool caller (the construction cycle is
  resolved with a late-bound runner).

## Quick start

```ts
import { createReferenceOrchestrator } from "@mcp-orchestrator/reference-impl";

const { orchestrator, workflows } = createReferenceOrchestrator({
  filesystemRoot: "./sandbox",
});

workflows.define({
  id: "write-then-read",
  inputs: { filename: { required: true }, body: { required: true } },
  steps: [
    { id: "write", tool: "filesystem.write_file", params: { path: "${input.filename}", content: "${input.body}" } },
    { id: "read", tool: "filesystem.read_file", params: { path: "${input.filename}" } },
  ],
  outputs: { contents: "${steps.read.output}" },
});

const run = await orchestrator.executeWorkflow("write-then-read", {
  filename: "note.txt",
  body: "hello sdk",
});
console.log(run); // outputs.contents === "hello sdk"
```
