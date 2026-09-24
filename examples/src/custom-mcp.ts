/**
 * Custom MCP example: stand up an in-process MCP with the InMemoryTransport,
 * connect a client, and discover its tools into an orchestrator.
 *
 * Run: npm run -w @mcp-orchestrator/examples custom-mcp
 */
import { Orchestrator } from "@mcp-orchestrator/core";
import { InMemoryTransport, McpClient, McpPool } from "@mcp-orchestrator/mcp";

const weatherTransport = new InMemoryTransport({
  tools: [
    {
      name: "forecast",
      description: "Return a canned forecast for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      handler: ({ city }) => ({ city: String(city), tempC: 21, sky: "clear" }),
    },
  ],
});

const client = new McpClient({ id: "weather", transport: weatherTransport });
const pool = new McpPool().add(client);
await pool.connectAll();

const orchestrator = new Orchestrator();
const discovered = await orchestrator.registerToolProvider(client);
console.log(
  "discovered tools:",
  discovered.map((t) => t.id),
);

const result = await orchestrator.callTool("weather.forecast", { city: "Lisbon" });
console.log("forecast:", result.output);

await pool.disconnectAll();
