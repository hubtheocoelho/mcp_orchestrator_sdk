import { createReferenceOrchestrator } from "./index.js";

/**
 * Executes a reference integration scenario demonstrating the assembled orchestrator,
 * streaming event consumption, and deterministic resource cleanup via dispose().
 */
export async function runHarness(options: { filesystemRoot?: string } = {}): Promise<void> {
  const { orchestrator } = createReferenceOrchestrator(options);

  try {
    const steps: Array<{ id: string; tool: string; params?: Record<string, any> }> = [
      {
        id: "step1",
        tool: "filesystem.write_file",
        params: { path: "hello.txt", content: "Runtime 2026 Ready" },
      },
      {
        id: "step2",
        tool: "filesystem.read_file",
        params: { path: "hello.txt" },
      },
    ];

    // Demonstrate executeWorkflowStream consuming events
    for await (const event of orchestrator.executeWorkflowStream("demo-wf", steps as any, {})) {
      if (event.type === "workflow.started") {
        // Workflow initiated
      } else if (event.type === "step.started") {
        // Step in progress
      } else if (event.type === "step.output") {
        // Step output produced
      } else if (event.type === "workflow.finished") {
        // Workflow completed cleanly
      }
    }
  } finally {
    // Explicit lifecycle hygiene
    await orchestrator.dispose();
  }
}
