/**
 * Basic agent example: register a tool and an agent with a restricted
 * allowlist, then call tools through the orchestrator with hooks and audit.
 *
 * Run: npm run -w @mcp-orchestrator/examples basic-agent
 */
import { InMemoryAuditSink, Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";

const add: ToolDefinition<{ a: number; b: number }, number> = {
  id: "math.add",
  description: "Add two numbers",
  safety: "read-only",
  schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  execute: ({ a, b }) => a + b,
};

const audit = new InMemoryAuditSink();
const orchestrator = new Orchestrator({ auditSinks: [audit] });

orchestrator.registerTool(add);
await orchestrator.registerAgent({ id: "calculator", tools: ["math.add"] });

orchestrator.onBeforeToolCall((p) => console.log(`→ ${p.caller} calling ${p.toolId}`, p.params));
orchestrator.onAfterToolCall((p) => console.log(`← ok=${p.result.ok} output=${p.result.output}`));

const ok = await orchestrator.callTool("math.add", { a: 2, b: 3 }, { caller: "calculator" });
console.log("result:", ok.output);

// The agent is not allowed to call a tool outside its allowlist.
orchestrator.registerTool({
  id: "math.mul",
  description: "multiply",
  schema: { type: "object" },
  execute: () => 0,
});
const blocked = await orchestrator.callTool("math.mul", {}, { caller: "calculator" });
console.log("blocked:", blocked.ok, blocked.error);

console.log(`audited ${audit.all().length} call(s)`);
