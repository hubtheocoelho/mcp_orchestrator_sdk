# Extending the SDK

Every extension point is a small TypeScript interface. Implement it and pass the
implementation in. No subclassing and no registration of plugin types are
needed.

| To add… | Implement | Hand it to |
|---------|-----------|------------|
| A tool | `ToolDefinition` | `orchestrator.registerTool()` |
| A group of tools | `ToolProvider` | `orchestrator.registerToolProvider()` |
| A way to reach an MCP server | `McpTransport` | `new McpClient({ transport })` |
| A persistence backend | `StateBackend` | `new StateManager(backend)` |
| An audit destination | `AuditSink` / `WorkflowAuditSink` | `auditSinks` option |
| Cross-cutting behavior | a hook handler | `orchestrator.hooks.on(...)` |

## Tools with custom validation

By default a tool's params are checked against its schema's `required` fields
and each property's top-level `type`. For anything richer, supply `validate`.
The example below wraps Zod, but any validator works.

```ts
import type { ToolDefinition } from "@mcp-orchestrator/core";
import { z } from "zod";

const Params = z.object({ email: z.string().email(), age: z.number().int().min(18) });

const signup: ToolDefinition<z.infer<typeof Params>, string> = {
  id: "users.signup",
  description: "Register an adult user",
  safety: "write",
  schema: { type: "object", required: ["email", "age"] },
  validate: (params) => {
    const parsed = Params.safeParse(params);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        };
  },
  execute: ({ email }) => `registered ${email}`,
};
```

Validation failures come back as a failed `ToolResult`
(`error: "Validation failed: …"`). The tool is not executed.

## A tool provider

Anything exposing `id` and `listToolDefinitions()` can be bulk-registered. Tools
it provides get `source` set to the provider's `id`.

```ts
import type { ToolDefinition, ToolProvider } from "@mcp-orchestrator/core";

class ClockProvider implements ToolProvider {
  readonly id = "clock";
  listToolDefinitions(): ToolDefinition[] {
    return [
      {
        id: "clock.now",
        description: "Current ISO timestamp",
        safety: "read-only",
        schema: { type: "object" },
        execute: () => new Date().toISOString(),
      },
    ];
  }
}
```

## An MCP transport

A transport only moves requests. Namespacing, discovery and registration are
handled by `McpClient`. This skeleton forwards over HTTP to a hypothetical
JSON endpoint:

```ts
import type { JsonObject, JsonValue } from "@mcp-orchestrator/core";
import type { McpTransport, RemoteToolDescriptor } from "@mcp-orchestrator/mcp";

class HttpTransport implements McpTransport {
  constructor(private readonly baseUrl: string) {}

  async start(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`MCP at ${this.baseUrl} is unhealthy`);
  }

  async close(): Promise<void> {}

  async listTools(): Promise<RemoteToolDescriptor[]> {
    const res = await fetch(`${this.baseUrl}/tools`);
    return (await res.json()) as RemoteToolDescriptor[];
  }

  async callTool(name: string, args: JsonObject): Promise<JsonValue> {
    const res = await fetch(`${this.baseUrl}/tools/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status}`);
    return (await res.json()) as JsonValue;
  }
}
```

Errors thrown by `callTool` become failed `ToolResult`s once the tool runs
through the orchestrator. `listResources` and `readResource` are optional.

## A state backend

`StateBackend` is pure storage. `StateManager` adds merging, querying, search
and change events on top, so a backend only needs five methods. Return copies
rather than live references, so callers cannot mutate stored state.

```ts
import type { Entity, StateBackend } from "@mcp-orchestrator/state";

/** Sketch: one JSON document per entity in any key-value store. */
class KeyValueBackend implements StateBackend {
  constructor(private readonly kv: Map<string, string>) {}

  private key(collection: string, id: string): string {
    return `${collection}/${id}`;
  }

  async get(collection: string, id: string): Promise<Entity | undefined> {
    const raw = this.kv.get(this.key(collection, id));
    return raw ? (JSON.parse(raw) as Entity) : undefined;
  }

  async set(collection: string, id: string, entity: Entity): Promise<void> {
    this.kv.set(this.key(collection, id), JSON.stringify(entity));
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.kv.delete(this.key(collection, id));
  }

  async list(collection: string): Promise<Entity[]> {
    const prefix = `${collection}/`;
    return [...this.kv.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => JSON.parse(v) as Entity);
  }

  async collections(): Promise<string[]> {
    return [...new Set([...this.kv.keys()].map((k) => k.split("/")[0] ?? ""))];
  }
}
```

`query` and `search` in `StateManager` call `list()` and filter in memory. For
large datasets, a backend-native query path is a planned extension.

## Audit sinks

```ts
import type { AuditSink } from "@mcp-orchestrator/core";

const slowCalls: AuditSink = {
  record({ call, result }) {
    if (result.durationMs > 1000) {
      console.warn(`slow tool ${call.toolId}: ${result.durationMs}ms`);
    }
  },
};
```

Tool audit sinks are best-effort: an error thrown by a sink is ignored and does
not affect the call. Workflow audit sinks are not yet isolated this way (see
[workflows.md](workflows.md#audit-trail)).

## Hooks: guardrails and enrichment

`beforeToolCall` handlers run in registration order before every call. They can
mutate `params`, or throw to veto the call; a veto becomes a failed `ToolResult`
carrying the thrown message.

```ts
import { Orchestrator } from "@mcp-orchestrator/core";

const orchestrator = new Orchestrator();

// Guardrail: destructive tools require an explicit confirmation flag.
orchestrator.onBeforeToolCall(({ toolId, params }) => {
  if (orchestrator.tools.get(toolId)?.safety === "destructive" && params.confirm !== true) {
    throw new Error(`${toolId} is destructive; pass confirm: true`);
  }
});

// Enrichment: stamp every call with a tenant id.
orchestrator.onBeforeToolCall((payload) => {
  payload.params.tenant = "acme";
});
```

`afterToolCall` and `error` handlers are for observation. If they throw, the
error is routed to the `error` event and the result is unaffected.

### Custom event maps

`HookManager` is generic, so you can reuse it for your own typed events:

```ts
import { HookManager } from "@mcp-orchestrator/core";

type DeployEvents = { deployStarted: { env: string }; deployFinished: { env: string; ok: boolean } };

const deployHooks = new HookManager<DeployEvents>();
deployHooks.on("deployFinished", ({ env, ok }) => console.log(env, ok));
await deployHooks.emit("deployFinished", { env: "prod", ok: true });
```
