# Streaming in MCP Orchestrator SDK (Runtime 2026)

The MCP Orchestrator SDK supports **Streaming-First** execution, enabling real-time event delivery during workflow execution and individual tool calls.

## Overview

Streaming allows callers to observe step-by-step progress, intermediate outputs, failures, and cancellation in real-time. This is ideal for:
- Terminal CLIs and rich console outputs
- Web UIs with progress bars or step visualizers
- Server-Sent Events (SSE) and WebSocket gateways
- Long-running multi-step agents

## Event Model: `OrchestratorEvent`

All events emitted during workflow execution conform to the `OrchestratorEvent` discriminated union:

```typescript
type OrchestratorEvent =
  | { type: "workflow.started"; workflowId: string; input: unknown }
  | { type: "step.started"; stepName: string; tool?: string }
  | { type: "step.progress"; stepName: string; progress: number; message?: string }
  | { type: "step.output"; stepName: string; output: unknown }
  | { type: "step.failed"; stepName: string; error: Error; willRetry: boolean }
  | { type: "workflow.finished"; workflowId: string; result: unknown }
  | { type: "workflow.failed"; workflowId: string; error: Error }
  | { type: "tool.chunk"; toolName: string; chunk: unknown }
  | { type: "token"; content: string };
```

## Basic Usage

### Streaming Workflow Execution

```typescript
import { Orchestrator } from "@mcp-orchestrator/core";

const orchestrator = new Orchestrator();

const steps = [
  { id: "fetch", tool: "github.get_issue", params: { issueNumber: 42 } },
  { id: "summarize", tool: "ai.summarize", params: { text: "${steps.fetch.output.body}" } },
  { id: "notify", tool: "slack.send_message", params: { message: "${steps.summarize.output}" } }
];

for await (const event of orchestrator.executeWorkflowStream("triage-issue", steps, {})) {
  switch (event.type) {
    case "workflow.started":
      console.log(`Workflow started: ${event.workflowId}`);
      break;
    case "step.started":
      console.log(`Step ${event.stepName} starting (${event.tool})...`);
      break;
    case "step.output":
      console.log(`Step ${event.stepName} produced output:`, event.output);
      break;
    case "step.failed":
      console.warn(`Step ${event.stepName} failed: ${event.error.message}`);
      break;
    case "workflow.finished":
      console.log(`Workflow finished with result:`, event.result);
      break;
    case "workflow.failed":
      console.error(`Workflow terminated with error:`, event.error);
      break;
  }
}
```

### Streaming Tool Calls

Individual tools can be executed via `callToolStream`:

```typescript
for await (const event of orchestrator.callToolStream("ai.generate_text", { prompt: "Explain MCP" })) {
  if (event.type === "tool.chunk") {
    process.stdout.write(event.chunk as string);
  }
}
```

If a tool does not support chunk streaming, a single `tool.chunk` event containing the full result is emitted automatically (degraded but consistent behavior).

## Guarantee of Termination

The asynchronous generator returned by `executeWorkflowStream` is guaranteed to terminate cleanly in all paths:
- **Success:** ends after yielding `workflow.finished`
- **Error:** ends immediately after yielding `step.failed` and `workflow.failed`
- **Cancellation:** ends immediately when `signal.aborted` is detected
