# @mcp-orchestrator/mcp

Transport-agnostic MCP (Model Context Protocol) access for the orchestrator.

## Install

```bash
npm install @mcp-orchestrator/mcp @mcp-orchestrator/core
```

## What's inside

- **`McpTransport`** — the only thing that knows *how* a server is reached. The
  client and pool are written entirely against this interface, so adding a new
  transport (stdio, HTTP, WebSocket, …) requires no changes elsewhere.
- **`InMemoryTransport`** — a ready in-process transport for tests and embedding
  MCP-style servers without spawning anything.
- **`McpClient`** — implements core's `ToolProvider`. It exposes each remote tool
  as a namespaced `ToolDefinition` (`${clientId}.${toolName}` by default) whose
  `execute` proxies to the transport. Also supports resources.
- **`McpPool`** — multiplexes many clients: bulk connect/disconnect, aggregated
  tool discovery and routed calls.

## Quick start

```ts
import { Orchestrator } from "@mcp-orchestrator/core";
import { InMemoryTransport, McpClient, McpPool } from "@mcp-orchestrator/mcp";

const client = new McpClient({
  id: "weather",
  transport: new InMemoryTransport({
    tools: [
      {
        name: "forecast",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        handler: ({ city }) => ({ city: String(city), tempC: 21 }),
      },
    ],
  }),
});

const pool = new McpPool().add(client);
await pool.connectAll();

const orchestrator = new Orchestrator();
await orchestrator.registerToolProvider(client); // registers "weather.forecast"

const result = await orchestrator.callTool("weather.forecast", { city: "Lisbon" });
console.log(result.output); // { city: "Lisbon", tempC: 21 }
```

## Implementing a transport

Implement `McpTransport` (`start`, `close`, `listTools`, `callTool`, optional
`listResources` / `readResource`) and hand it to an `McpClient`. See
`InMemoryTransport` for a reference.
