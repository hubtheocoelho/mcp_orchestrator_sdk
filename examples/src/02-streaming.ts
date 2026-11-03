import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";

const stepTool: ToolDefinition<{ text: string }, string> = {
  id: "process",
  description: "Processes text step",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: (params) => `Processed: ${params.text}`,
};

export async function main(): Promise<void> {
  const orchestrator = new Orchestrator();

  try {
    orchestrator.registerTool(stepTool);

    const steps = [
      { id: "step1", tool: "process", params: { text: "Chunk 1" } },
      { id: "step2", tool: "process", params: { text: "Chunk 2" } },
      { id: "step3", tool: "process", params: { text: "Chunk 3" } },
    ];

    console.log("Streaming workflow execution:");
    for await (const event of orchestrator.executeWorkflowStream("stream-wf", steps, {})) {
      switch (event.type) {
        case "workflow.started":
          console.log(`[START] Workflow ${event.workflowId}`);
          break;
        case "step.started":
          console.log(`[STEP] Started: ${event.stepName} (${event.tool})`);
          break;
        case "step.output":
          console.log(`[OUTPUT] ${event.stepName} ->`, event.output);
          break;
        case "workflow.finished":
          console.log(`[FINISH] Result:`, event.result);
          break;
        case "workflow.failed":
          console.error(`[FAILED]`, event.error);
          break;
      }
    }
  } finally {
    await orchestrator.dispose();
  }
}

if (process.argv[1]?.endsWith("02-streaming.ts")) {
  main().catch(console.error);
}
