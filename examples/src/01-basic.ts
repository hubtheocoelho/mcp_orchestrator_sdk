import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";

const echoTool: ToolDefinition<{ message: string }, string> = {
  id: "echo",
  description: "Echoes the message back",
  schema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  safety: "read-only",
  execute: (params) => params.message,
};

export async function main(): Promise<void> {
  const orchestrator = new Orchestrator();

  try {
    orchestrator.registerTool(echoTool);
    const result = await orchestrator.callTool("echo", { message: "Hello, MCP Orchestrator 2026!" });
    console.log("Result:", result.output);
  } finally {
    await orchestrator.dispose();
  }
}

if (process.argv[1]?.endsWith("01-basic.ts")) {
  main().catch(console.error);
}
