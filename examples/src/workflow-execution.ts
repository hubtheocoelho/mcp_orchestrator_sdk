/**
 * Workflow example: define a multi-step workflow with interpolation and a
 * conditional gate, then execute it through the engine with an audit trail.
 *
 * Run: npm run -w @mcp-orchestrator/examples workflow
 */
import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";
import { JsonlWorkflowAuditSink, WorkflowEngine } from "@mcp-orchestrator/workflow";

const tools: ToolDefinition[] = [
  {
    id: "text.upper",
    description: "uppercase",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: (p) => String((p as { text: string }).text).toUpperCase(),
  },
  {
    id: "text.repeat",
    description: "repeat text n times",
    schema: { type: "object", required: ["text", "n"] },
    execute: (p) => {
      const { text, n } = p as { text: string; n: number };
      return Array.from({ length: n }, () => text).join(" ");
    },
  },
];

const orchestrator = new Orchestrator();
for (const tool of tools) orchestrator.registerTool(tool);

const engine = new WorkflowEngine({
  tools: orchestrator,
  auditSinks: [new JsonlWorkflowAuditSink()],
});

engine.define({
  id: "chant",
  description: "Uppercase a word then repeat it",
  inputs: { word: { required: true }, times: { default: 3 } },
  steps: [
    { id: "up", tool: "text.upper", params: { text: "${input.word}" } },
    {
      id: "rep",
      tool: "text.repeat",
      params: { text: "${steps.up.output}", n: "${input.times}" },
      when: "${input.times} > 0",
    },
  ],
  outputs: { chant: "${steps.rep.output}" },
});

const result = await engine.execute("chant", { word: "go", times: 3 });
console.log("ok:", result.ok);
console.log("chant:", result.outputs.chant);
console.log("steps:", result.steps.map((s) => `${s.id}:${s.status}`).join(", "));
