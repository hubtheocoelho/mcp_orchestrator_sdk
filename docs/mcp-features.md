# MCP Features

The SDK touches MCP in two directions (see [ADR 0001](adr/0001-mcp-server-layer.md)):

- **Server side — `@mcp-orchestrator/mcp-server`.** Exposes workflows as tools of
  a real MCP server built on the official `@modelcontextprotocol/sdk`, which owns
  JSON-RPC framing, `initialize`, capability negotiation and the stdio and
  streamable HTTP transports. This is the spec-compliant path for MCP clients
  (Claude, IDE agents). See [Workflows as MCP tools](#workflows-as-mcp-tools).
- **Client side — `@mcp-orchestrator/mcp`.** Lets workflows call *other* servers
  through the `McpTransport` interface. It does **not** implement the official
  protocol: there is no JSON-RPC framing, no `initialize` handshake and no stdio
  transport, and `HttpTransport` speaks its own REST contract
  (`GET /tools`, `POST /tools/:name/call`). The table below describes the
  `McpClient` API surface, not wire-level spec conformance.

## Workflows as MCP tools

```ts
import { McpWorkflowServer, serveStdio } from "@mcp-orchestrator/mcp-server";

const server = new McpWorkflowServer({ name: "my-workflows", version: "1.0.0", engine });
await serveStdio(server); // or createStreamableHttpHandler(server) for HTTP
```

Each workflow is one tool (name = workflow id, `inputSchema` from its `inputs`).
A `needs_input` step hands control back to the LLM:

- **Mode A — elicitation.** When the client declared the `elicitation`
  capability, the server sends `elicitation/create` inside the same
  `tools/call` and the run continues on the same `runId`. A timeout or
  disconnect falls back to Mode B.
- **Mode B — explicit pause.** Otherwise (or with `mode: "suspend"`, server-wide
  or per workflow) the run is checkpointed and the tool returns
  `{ status: "suspended", runId, resumeToken, request: { message, schema } }`.
  The client resumes with the `resume_workflow` tool
  (`{ runId, resumeToken, input }`). Tokens are single-use; a wrong token or
  input that does not match `request.schema` fails without changing the run.

Use durable `checkpointStore` and `suspensionStore` implementations in
production; the in-memory defaults lose suspended runs on restart.

## `McpClient` API surface

| Feature | Supported | Client API | Description |
|---|---|---|---|
| **Tools (`tools/list`, `tools/call`)** | ✅ Yes | `getTools()`, `callTool()` | Discover and invoke remote tools with schema validation |
| **Resources (`resources/list`, `resources/read`)** | ✅ Yes | `listResources()`, `readResource(uri)` | Query and read text/binary resources exposed by servers |
| **Prompts (`prompts/list`, `prompts/get`)** | ✅ Yes | `listPrompts()`, `getPrompt(name, args)` | Retrieve reusable prompt templates and arguments |
| **Sampling (`sampling/createMessage`)** | ✅ Yes | `samplingHandler` option | Allows server to request model completions from client |
| **Progress (`notifications/progress`)** | ✅ Yes | `onProgress` option | Real-time progress updates for long-running tool runs |
| **Roots (`roots/list`)** | ✅ Yes | `setRoots(roots)` | Informs servers about client workspace directories |
| **Cancellation (`notifications/cancelled`)** | ✅ Yes | `signal` option / `AbortSignal` | Cooperative cancellation of requests in flight |

## Sampling (Client Completion)

When an MCP server requires LLM intelligence (e.g. to synthesize content or refine arguments), it issues a `sampling/createMessage` request to the client. The client delegates to the user-supplied handler:

```typescript
const client = new McpClient({
  id: "agentic-server",
  transport,
  samplingHandler: async (req) => {
    // Call LLM provider (Anthropic, Gemini, OpenAI, etc.)
    return {
      role: "assistant",
      content: { type: "text", text: "Completion response" },
      model: "claude-3-7-sonnet",
      stopReason: "endTurn",
    };
  },
});
```

## Progress Notifications

For tools with non-trivial runtimes, progress notifications are forwarded to the client's `onProgress` callback:

```typescript
const client = new McpClient({
  id: "data-cruncher",
  transport,
  onProgress: (notification) => {
    console.log(`Progress on ${notification.progressToken}: ${notification.progress}/${notification.total}`);
  },
});
```
