# Migration Guide: Upgrading to Runtime 2026

The Runtime 2026 evolution is **100% additive and backwards-compatible**. All existing workflows, tool definitions, state backends, and MCP transports continue to work without modification.

This guide illustrates how to adopt the new features alongside existing code.

## 1. Migrating to Streaming (`executeWorkflowStream`)

### Before (Batch execution)

```typescript
// Legacy execution - waits for entire workflow to complete
const result = await orchestrator.executeWorkflow("my-workflow", { inputParam: "value" });
console.log("Final outputs:", result);
```

### After (Streaming execution)

```typescript
// Real-time incremental event stream
for await (const event of orchestrator.executeWorkflowStream("my-workflow", steps, { inputParam: "value" })) {
  if (event.type === "step.started") {
    console.log(`Step ${event.stepName} is running...`);
  } else if (event.type === "step.output") {
    console.log(`Step ${event.stepName} output:`, event.output);
  } else if (event.type === "workflow.finished") {
    console.log("Final outputs:", event.result);
  }
}
```

## 2. Adding Cancellation (`AbortSignal`)

Any workflow or tool call can now be cancelled cooperatively by passing an `AbortSignal`:

```typescript
const controller = new AbortController();

// Cancel after 5 seconds timeout
setTimeout(() => controller.abort(), 5000);

try {
  for await (const event of orchestrator.executeWorkflowStream(
    "long-workflow",
    steps,
    {},
    { signal: controller.signal }
  )) {
    // Process events...
  }
} catch (err) {
  if (err instanceof OrchestratorAbortError) {
    console.log("Workflow was cleanly cancelled.");
  }
}
```

## 3. Explicit Resource Management (`dispose`)

`Orchestrator`, `McpClient`, `HttpTransport`, and `StateManager` now implement `dispose(): Promise<void>` and `Symbol.asyncDispose`:

```typescript
// Explicit lifecycle with using (TypeScript 5.2+)
await using orchestrator = new Orchestrator();
// Or classic try/finally:
const client = new McpClient({ id: "server", transport });
try {
  await client.connect();
} finally {
  await client.dispose();
}
```

## 4. Workflow Resilience: `onError` & Checkpoints

Instead of failing the entire workflow on step error, steps can declare `onError: "continue"` or resume from durable checkpoints:

```typescript
// Step definition with onError continue
{
  id: "optional-step",
  tool: "analytics.track",
  onError: "continue" // Does not halt the workflow if tracking fails
}

// Resuming from checkpoint
const checkpointStore = new InMemoryCheckpointStore();
const result = await executor.resume(workflowDefinition, checkpointStore);
```
