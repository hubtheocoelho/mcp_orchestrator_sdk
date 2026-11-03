import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";

const slowTool: ToolDefinition = {
  id: "slow",
  description: "Simulates long operation",
  schema: { type: "object" },
  execute: () => new Promise((resolve) => setTimeout(() => resolve("done"), 500)),
};

export async function main(): Promise<void> {
  const orchestrator = new Orchestrator();
  const controller = new AbortController();

  try {
    orchestrator.registerTool(slowTool);

    const steps = [
      { id: "step1", tool: "slow" },
      { id: "step2", tool: "slow" },
    ];

    // Abort after 100ms
    setTimeout(() => {
      console.log("--> Triggering cancellation via AbortSignal");
      controller.abort();
    }, 100);

    for await (const event of orchestrator.executeWorkflowStream(
      "cancellation-wf",
      steps,
      {},
      { signal: controller.signal },
    )) {
      console.log("Event:", event.type);
    }
  } finally {
    await orchestrator.dispose();
  }
}

if (process.argv[1]?.endsWith("03-cancellation.ts")) {
  main().catch(console.error);
}
