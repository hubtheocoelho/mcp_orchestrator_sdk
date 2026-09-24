# Getting started

## Install & build

```bash
npm install
npm run build     # tsc --build across all packages
npm test          # node:test over every *.test.ts
```

The repo is an npm-workspaces monorepo; packages are published under the
`@mcp-orchestrator/*` scope and reference each other via TypeScript project
references.

## Your first orchestrator

```ts
import { Orchestrator, type ToolDefinition } from "@mcp-orchestrator/core";

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

const orchestrator = new Orchestrator();
orchestrator.registerTool(add);

const result = await orchestrator.callTool("math.add", { a: 2, b: 3 });
console.log(result.output); // 5
```

## Add hooks and an agent

```ts
orchestrator.onBeforeToolCall((p) => console.log("calling", p.toolId));
await orchestrator.registerAgent({ id: "calculator", tools: ["math.add"] });

// Calls made as an agent are checked against its allowlist.
await orchestrator.callTool("math.add", { a: 1, b: 1 }, { caller: "calculator" });
```

## Run a workflow

```ts
import { WorkflowEngine } from "@mcp-orchestrator/workflow";

const engine = new WorkflowEngine({ tools: orchestrator });
engine.define({
  id: "sum-twice",
  inputs: { x: { required: true } },
  steps: [
    { id: "s1", tool: "math.add", params: { a: "${input.x}", b: "${input.x}" } },
  ],
  outputs: { total: "${steps.s1.output}" },
});

const run = await engine.execute("sum-twice", { x: 21 });
console.log(run.outputs.total); // 42
```

## Connect an MCP

```ts
import { InMemoryTransport, McpClient } from "@mcp-orchestrator/mcp";

const client = new McpClient({
  id: "weather",
  transport: new InMemoryTransport({
    tools: [{ name: "forecast", handler: ({ city }) => ({ city: String(city), tempC: 21 }) }],
  }),
});
await client.connect();
await orchestrator.registerToolProvider(client); // registers "weather.forecast"
```

## More

See [`../examples`](../examples) for four runnable programs and
[`architecture.md`](architecture.md) for the design, and
[`api-reference.md`](api-reference.md) for the public surface.
