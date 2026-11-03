// Orchestrator streaming events
// This file defines the public event types emitted by the Orchestrator during workflow execution.
// It is additive and does not affect existing APIs.

export type OrchestratorEvent =
  | { type: "workflow.started"; workflowId: string; input: unknown }
  | { type: "step.started"; stepName: string; tool?: string }
  | { type: "step.progress"; stepName: string; progress: number; message?: string }
  | { type: "step.output"; stepName: string; output: unknown }
  | { type: "step.failed"; stepName: string; error: Error; willRetry: boolean }
  | { type: "workflow.finished"; workflowId: string; result: unknown }
  // Workflow level failure (including abort)
  | { type: "workflow.failed"; workflowId: string; error: Error }
  // Streaming chunks from a tool invocation
  | { type: "tool.chunk"; toolName: string; chunk: unknown }
  // Token emitted by LLMs (if applicable)
  | { type: "token"; content: string };
