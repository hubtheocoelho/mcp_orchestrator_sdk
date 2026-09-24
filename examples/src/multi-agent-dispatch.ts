/**
 * Multi-agent dispatch example: a reader agent (read-only) and a writer agent
 * (state mutations), sharing an orchestrator with a reactive state manager.
 * Demonstrates allowlists, delegation and state change subscriptions.
 *
 * Run: npm run -w @mcp-orchestrator/examples multi-agent
 */
import { Orchestrator, type JsonValue, type ToolDefinition } from "@mcp-orchestrator/core";
import { StateManager } from "@mcp-orchestrator/state";

const state = new StateManager();
const orchestrator = new Orchestrator({ state });

const readProfile: ToolDefinition<{ id: string }, JsonValue> = {
  id: "profile.read",
  description: "Read a user profile",
  safety: "read-only",
  schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  execute: async ({ id }) => (await state.get("profiles", id)) ?? null,
};

const writeProfile: ToolDefinition<{ id: string; name: string }, JsonValue> = {
  id: "profile.write",
  description: "Create or update a user profile",
  safety: "write",
  schema: { type: "object", required: ["id", "name"] },
  execute: ({ id, name }) => state.update("profiles", id, { name }),
};

orchestrator.registerTool(readProfile);
orchestrator.registerTool(writeProfile);

await orchestrator.registerAgent({ id: "reader", tools: ["profile.read"] });
await orchestrator.registerAgent({ id: "writer", tools: ["profile.write"] });

state.onChanged((e) => console.log(`[state] ${e.type} ${e.collection}/${e.id}`));

// Writer creates a profile; reader reads it back.
await orchestrator.callTool("profile.write", { id: "u1", name: "Theo" }, { caller: "writer" });
const read = await orchestrator.callTool("profile.read", { id: "u1" }, { caller: "reader" });
console.log("reader saw:", read.output);

// Reader is not permitted to write.
const denied = await orchestrator.callTool("profile.write", { id: "u1", name: "x" }, { caller: "reader" });
console.log("reader write denied:", denied.ok, denied.error);
