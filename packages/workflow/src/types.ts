import type { JsonObject, OrchestratorEvent, Tracer } from "@mcp-orchestrator/core";
import type { CheckpointStore } from "./checkpoint.js";
import type { InputRequest } from "./schema.js";

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
  /**
   * Present when the run paused at a `needs_input` step: `ok` is false and
   * `error` is absent. The checkpoint is kept so the run can be resumed with
   * `context.resumeInput`.
   */
  readonly suspended?: WorkflowSuspension;
}

/** Where and why a run paused waiting for input. */
export interface WorkflowSuspension {
  readonly stepId: string;
  readonly request: InputRequest;
}

/** What an {@link InputProvider} answered. */
export type InputResponse =
  | { readonly action: "accept"; readonly content: JsonObject }
  | { readonly action: "decline" | "cancel" }
  /** Stop the run here and keep its checkpoint, to be resumed later. */
  | { readonly action: "suspend" };

/**
 * Answers `needs_input` steps while the run is live (e.g. through MCP
 * elicitation). Without one, such steps suspend the run.
 */
export type InputProvider = (
  request: InputRequest,
  info: {
    readonly workflowId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly signal?: AbortSignal;
  },
) => Promise<InputResponse>;

/**
 * The minimal tool-calling surface the executor needs. Core's Orchestrator
 * (`callTool`) satisfies this structurally, as does a bare ToolRegistry wrapper.
 */
export interface ToolCaller {
  callTool(
    toolId: string,
    params: JsonObject,
    options?: {
      caller?: string;
      callId?: string;
      signal?: AbortSignal;
      onProgress?: (progress: number, message?: string) => void;
    },
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
  /**
   * Receives a streaming {@link OrchestratorEvent} for every lifecycle
   * transition (used by `Orchestrator.executeWorkflowStream`/`streamWorkflow`).
   * Exceptions thrown by the listener are swallowed.
   */
  onEvent?: (event: OrchestratorEvent) => void;
  /** Answers `needs_input` steps in-line; when absent such steps suspend the run. */
  inputProvider?: InputProvider;
  /**
   * Input for the `needs_input` step a run resumes at. Used once, and only when
   * `stepId` is the first `needs_input` step reached.
   */
  resumeInput?: { readonly stepId: string; readonly content: JsonObject };
}
