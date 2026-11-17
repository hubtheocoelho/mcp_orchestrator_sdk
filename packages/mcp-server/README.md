# @mcp-orchestrator/mcp-server

Expose workflows as tools of an MCP server built on the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
Design: [ADR 0001](../../docs/adr/0001-mcp-server-layer.md).

```ts
import { WorkflowEngine } from "@mcp-orchestrator/workflow";
import { McpWorkflowServer, serveStdio } from "@mcp-orchestrator/mcp-server";

const engine = new WorkflowEngine({ tools });
engine.define({
  id: "triage_bug",
  description: "File a bug after confirming severity with the user",
  inputs: { title: { type: "string", required: true } },
  steps: [
    {
      id: "severity",
      needs_input: {
        message: "What severity is this?",
        schema: { type: "object", properties: { level: { type: "string", enum: ["low", "high"] } }, required: ["level"] },
      },
    },
    { id: "file", tool: "jira.create", params: { title: "${input.title}", severity: "${steps.severity.output.level}" } },
  ],
});

await serveStdio(new McpWorkflowServer({ name: "triage", version: "1.0.0", engine }));
```

## Handing control back to the LLM

A `needs_input` step is written once; the server picks the mode per call:

| Mode | When | What the client sees |
|---|---|---|
| A — elicitation | client declared `elicitation` and mode is `"auto"` (default) | one `tools/call`; an `elicitation/create` request mid-run |
| B — suspend | client lacks elicitation, `mode: "suspend"` (server or per workflow), or elicitation timed out | `{ status: "suspended", runId, resumeToken, request }`, then a `resume_workflow` call |

`resume_workflow` takes `{ runId, resumeToken, input }`. Tokens are single-use
and stored hashed; a wrong token or input not matching `request.schema` fails
without consuming the token or touching the checkpoint.

## Options

`McpWorkflowServerOptions`: `name`, `version`, `engine`, `workflows` (ids, or
`{ [id]: { mode, description } }`), `mode`, `checkpointStore`,
`suspensionStore`, `elicitationTimeoutMs` (default 10 min), `resumeToolName`,
`instructions`. Production deployments need durable checkpoint and suspension
stores.

## Transports

- `serveStdio(server)` — stdin/stdout.
- `createStreamableHttpHandler(server)` — a Node `(req, res, body?)` handler
  with one session per client (`mcp-session-id`); call `handler.close()` on
  shutdown.
