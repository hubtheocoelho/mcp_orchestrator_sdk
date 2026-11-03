import type { JsonObject, Tracer } from "@mcp-orchestrator/core";
import type { CheckpointStore } from "./checkpoint.js";

/** Outcome of a single step within a workflow run. */
export interface StepResult {
  readonly id: string;
  readonly toolId: string;
  readonly status: "success" | "failed" | "skipped";
  readonly output?: unknown;
  readonly error?: string;
  /** Number of execution attempts (>= 1 for run steps, 0 for skipped). */
  readonly attempts: number;
  readonly durationMs: number;
}

/** Outcome of a whole workflow run. */
export interface WorkflowResult {
  readonly workflowId: string;
  readonly runId: string;
  readonly ok: boolean;
  readonly outputs: JsonObject;
  readonly steps: StepResult[];
  readonly durationMs: number;
  /** Present when the run failed. */
  readonly error?: string;
}

/**
 * The minimal tool-calling surface the executor needs. Core's Orchestrator
 * (`callTool`) satisfies this structurally, as does a bare ToolRegistry wrapper.
 */
export interface ToolCaller {
  callTool(
    toolId: string,
    params: JsonObject,
    options?: { caller?: string; callId?: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; output?: unknown; error?: string }>;
}

/** Per-run execution context. */
export interface ExecutionContext {
  /** Correlation id for the run; generated when omitted. */
  runId?: string;
  /** Who is running the workflow (propagated as the tool caller). */
  caller?: string;
  signal?: AbortSignal;
  /** Optional tracer for observing execution steps. */
  tracer?: Tracer;
  /** Optional store for durable execution checkpoints. */
  checkpointStore?: CheckpointStore;
}
