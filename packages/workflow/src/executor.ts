import { randomUUID } from "node:crypto";
import {
  NoopTracer,
  OrchestratorAbortError,
  type JsonObject,
  type OrchestratorEvent,
  type Tracer,
} from "@mcp-orchestrator/core";
import type { WorkflowAuditSink } from "./audit.js";
import type { CheckpointStore } from "./checkpoint.js";
import {
  evaluateCondition,
  interpolate,
  interpolateParams,
  type ExpressionScope,
} from "./expression.js";
import type { WorkflowDefinition, WorkflowStep } from "./schema.js";
import type { ExecutionContext, StepResult, ToolCaller, WorkflowResult } from "./types.js";

/** Thrown when required inputs are missing or otherwise invalid. */
export class WorkflowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

export interface ExecutorOptions {
  tools: ToolCaller;
  auditSinks?: WorkflowAuditSink[];
  tracer?: Tracer;
}

/**
 * Runs a validated {@link WorkflowDefinition} step by step against a
 * {@link ToolCaller}: applies input defaults, evaluates `when`/`stop_when`
 * gates, interpolates params, enforces on-failure policies (fail/skip/retry/continue),
 * supports parallel steps, checkpoints for resume, and instruments spans via Tracer.
 */
export class WorkflowExecutor {
  private readonly tools: ToolCaller;
  private readonly sinks: WorkflowAuditSink[];
  private readonly tracer: Tracer;

  constructor(options: ExecutorOptions) {
    this.tools = options.tools;
    this.sinks = options.auditSinks ?? [];
    this.tracer = options.tracer ?? NoopTracer;
  }

  async execute(
    definition: WorkflowDefinition,
    rawInputs: JsonObject = {},
    context: ExecutionContext = {},
    startIndex = 0,
    restoredScope?: ExpressionScope,
  ): Promise<WorkflowResult> {
    const runId = context.runId ?? randomUUID();
    const startedAt = Date.now();
    const tracer = context.tracer ?? this.tracer;
    const input = this.resolveInputs(definition, rawInputs);

    const workflowSpan = tracer.startSpan("workflow.execute", {
      "workflow.id": definition.id,
      "run.id": runId,
    });

    const scope: ExpressionScope = restoredScope ?? { input, steps: {} };
    const steps: StepResult[] = [];

    await this.emit({ type: "run-start", runId, workflowId: definition.id, at: Date.now() });
    const resumed = startIndex > 0 || restoredScope !== undefined;
    notify(context, {
      type: "workflow.started",
      workflowId: definition.id,
      input: scope.input,
      ...(resumed ? { resumed: true, fromStep: startIndex } : {}),
    });
    let lastOutput: unknown;

    let failure: string | undefined;
    // True when the run stopped because of a failure ("fail"/exhausted "retry"/abort).
    // Failures under the "continue" policy are reported but still resolve outputs.
    let hardFailure = false;

    try {
    for (let i = startIndex; i < definition.steps.length; i++) {
      const step = definition.steps[i]!;

      if (context.signal?.aborted) {
        failure = ABORT_MESSAGE;
        hardFailure = true;
        break;
      }

      if (step.when && !evaluateCondition(step.when, scope)) {
        const skipped: StepResult = {
          id: step.id,
          toolId: step.tool,
          status: "skipped",
          attempts: 0,
          durationMs: 0,
        };
        steps.push(skipped);
        await this.emit({ type: "step-complete", runId, step: skipped, at: Date.now() });
        continue;
      }

      await this.emit({ type: "step-start", runId, stepId: step.id, toolId: step.tool, at: Date.now() });
      notify(context, { type: "step.started", stepName: step.id, tool: step.tool });

      const stepSpan = tracer.startSpan(`workflow.step.${step.id}`, {
        "workflow.id": definition.id,
        "step.name": step.id,
        "tool.name": step.tool,
      });

      let result: StepResult;
      try {
        result = await this.runStep(step, scope, context, runId);
        stepSpan.setAttribute("step.status", result.status);
        stepSpan.setAttribute("step.duration_ms", result.durationMs);
        if (result.status === "failed" && result.error) {
          stepSpan.recordException(new Error(result.error));
        }
      } catch (err) {
        stepSpan.recordException(err);
        throw err;
      } finally {
        stepSpan.end();
      }
      steps.push(result);

      await this.emit({ type: "step-complete", runId, step: result, at: Date.now() });

      const policy = step.onError ?? step.on_failure;

      if (context.signal?.aborted) {
        // An abort always stops the run, whatever the step's failure policy.
        notify(context, { type: "step.failed", stepName: step.id, error: new OrchestratorAbortError(), willRetry: false });
        failure = ABORT_MESSAGE;
        hardFailure = true;
        break;
      }

      if (result.status === "success") {
        notify(context, { type: "step.output", stepName: step.id, output: result.output });
        lastOutput = result.output;
        scope.steps[step.id] = { output: result.output };
        if (context.checkpointStore) {
          await context.checkpointStore.save({
            workflowId: definition.id,
            runId,
            stepIndex: i + 1,
            state: JSON.parse(JSON.stringify(scope)),
            timestamp: Date.now(),
          });
        }
        if (step.stop_when && evaluateCondition(step.stop_when, scope)) break;
        continue;
      }

      notify(context, {
        type: "step.failed",
        stepName: step.id,
        error: new Error(result.error ?? "unknown error"),
        willRetry: false,
      });

      if (policy === "skip") {
        // "skip" continues past a failed step without failing the workflow
      } else if (policy === "continue") {
        // "continue" continues past a failed step, but reports failure at the end
        failure = failure ?? `Step "${step.id}" failed: ${result.error}`;
        scope.steps[step.id] = { output: result.output };
      } else {
        // "fail", and "retry" once exhausted, abort the run.
        failure = `Step "${step.id}" failed: ${result.error}`;
        hardFailure = true;
        if (context.checkpointStore) {
          await context.checkpointStore.save({
            workflowId: definition.id,
            runId,
            stepIndex: i,
            state: JSON.parse(JSON.stringify(scope)),
            timestamp: Date.now(),
          });
        }
        break;
      }
    }
    } catch (err) {
      workflowSpan.recordException(err);
      workflowSpan.end();
      notify(context, {
        type: "workflow.failed",
        workflowId: definition.id,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw err;
    }

    if (failure) {
      workflowSpan.recordException(new Error(failure));
    }
    workflowSpan.end();

    const outputs = hardFailure ? {} : this.resolveOutputs(definition, scope);

    const result: WorkflowResult = {
      workflowId: definition.id,
      runId,
      ok: !failure,
      outputs,
      steps,
      durationMs: Date.now() - startedAt,
      error: failure,
    };

    if (!hardFailure && context.checkpointStore) {
      await context.checkpointStore.clear(definition.id, runId);
    }

    await this.emit({ type: "run-complete", runId, result, at: Date.now() });
    if (failure) {
      notify(context, {
        type: "workflow.failed",
        workflowId: definition.id,
        error: failure === ABORT_MESSAGE ? new OrchestratorAbortError(ABORT_MESSAGE) : new Error(failure),
      });
    } else {
      notify(context, {
        type: "workflow.finished",
        workflowId: definition.id,
        // Declared outputs when the definition has any, else the last step output.
        result: Object.keys(definition.outputs).length > 0 ? outputs : lastOutput,
      });
    }
    return result;
  }

  /**
   * Resume a run from its checkpoint in `checkpointStore`. Pass `context.runId`
   * to resume a specific run; otherwise the most recently checkpointed run of
   * the workflow is resumed (under its original runId).
   */
  async resume(
    definition: WorkflowDefinition,
    checkpointStore: CheckpointStore,
    context: ExecutionContext = {},
  ): Promise<WorkflowResult> {
    const checkpoint = await checkpointStore.load(definition.id, context.runId);
    if (!checkpoint) {
      return this.execute(definition, {}, { ...context, checkpointStore });
    }
    return this.execute(
      definition,
      checkpoint.state.input,
      { ...context, runId: checkpoint.runId, checkpointStore },
      checkpoint.stepIndex,
      checkpoint.state,
    );
  }

  private async runStep(
    step: WorkflowStep,
    scope: ExpressionScope,
    context: ExecutionContext,
    runId: string,
  ): Promise<StepResult> {
    const params = interpolateParams(step.params as JsonObject, scope);
    const policy = step.onError ?? step.on_failure;
    const maxAttempts = policy === "retry" ? Math.max(1, step.retry?.max ?? 1) : 1;
    const delayMs = step.retry?.delayMs ?? 0;
    const startedAt = Date.now();

    // Support parallel step execution if step.parallel is defined
    if (step.parallel && step.parallel.length > 0) {
      for (const toolName of step.parallel) {
        await this.emit({
          type: "step-start",
          runId,
          stepId: `${step.id}.${toolName}`,
          toolId: toolName,
          at: Date.now(),
        });
      }

      const results = await Promise.all(step.parallel.map(async (toolName, idx) => {
        const taskStartedAt = Date.now();
        const outcome = await this.safeCallTool(toolName, params, {
          caller: context.caller,
          callId: `${runId}:${step.id}:${toolName}:${idx}`,
          signal: context.signal,
          onProgress: progressFor(context, `${step.id}.${toolName}`),
        });

        await this.emit({
          type: "step-complete",
          runId,
          step: {
            id: `${step.id}.${toolName}`,
            toolId: toolName,
            status: outcome.ok ? "success" : "failed",
            output: outcome.output,
            error: outcome.error,
            attempts: 1,
            durationMs: Date.now() - taskStartedAt,
          },
          at: Date.now(),
        });

        return { toolName, outcome };
      }));

      const anyFailed = results.find((r) => !r.outcome.ok);
      const aggregatedOutputs = results.map((r) => r.outcome.output);

      return {
        id: step.id,
        toolId: step.tool,
        status: anyFailed ? "failed" : "success",
        error: anyFailed ? (anyFailed.outcome.error ?? "Parallel execution failed") : undefined,
        output: aggregatedOutputs as StepResult["output"],
        attempts: 1,
        durationMs: Date.now() - startedAt,
      };
    }

    let lastError = "unknown error";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (context.signal?.aborted) {
        lastError = ABORT_MESSAGE;
        return {
          id: step.id,
          toolId: step.tool,
          status: "failed",
          error: lastError,
          attempts: attempt - 1,
          durationMs: Date.now() - startedAt,
        };
      }
      const outcome = await this.safeCallTool(step.tool, params, {
        caller: context.caller,
        callId: `${runId}:${step.id}:${attempt}`,
        signal: context.signal,
        onProgress: progressFor(context, step.id),
      });
      if (outcome.ok) {
        return {
          id: step.id,
          toolId: step.tool,
          status: "success",
          output: outcome.output,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
      }
      lastError = outcome.error ?? "unknown error";
      if (attempt < maxAttempts && !context.signal?.aborted) {
        notify(context, { type: "step.failed", stepName: step.id, error: new Error(lastError), willRetry: true });
        if (delayMs > 0) await delay(delayMs);
      }
    }

    return {
      id: step.id,
      toolId: step.tool,
      status: "failed",
      error: lastError,
      attempts: maxAttempts,
      durationMs: Date.now() - startedAt,
    };
  }

  private resolveInputs(definition: WorkflowDefinition, rawInputs: JsonObject): JsonObject {
    const input: JsonObject = { ...rawInputs };
    for (const [name, spec] of Object.entries(definition.inputs)) {
      if (input[name] === undefined && spec.default !== undefined) {
        input[name] = spec.default as JsonObject[string];
      }
      if (input[name] === undefined && spec.required) {
        throw new WorkflowInputError(`Missing required input: ${name}`);
      }
    }
    return input;
  }

  private resolveOutputs(definition: WorkflowDefinition, scope: ExpressionScope): JsonObject {
    const outputs: JsonObject = {};
    for (const [name, expression] of Object.entries(definition.outputs)) {
      outputs[name] = interpolate(expression, scope) as JsonObject[string];
    }
    return outputs;
  }

  /**
   * Calls a tool and converts a thrown error (e.g. a caller that rejects on
   * abort) into a failed outcome, so the executor always returns a
   * {@link WorkflowResult} instead of throwing.
   */
  private async safeCallTool(
    ...args: Parameters<ToolCaller["callTool"]>
  ): Promise<Awaited<ReturnType<ToolCaller["callTool"]>>> {
    try {
      return await this.tools.callTool(...args);
    } catch (err) {
      const aborted =
        args[2]?.signal?.aborted || err instanceof OrchestratorAbortError || (err as Error)?.name === "AbortError";
      return { ok: false, error: aborted ? ABORT_MESSAGE : ((err as Error)?.message ?? String(err)) };
    }
  }

  private async emit(event: Parameters<WorkflowAuditSink["record"]>[0]): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.record(event)));
  }
}

const ABORT_MESSAGE = "Workflow aborted";

/** Deliver a streaming event; a throwing listener must never break the run. */
function notify(context: ExecutionContext, event: OrchestratorEvent): void {
  if (!context.onEvent) return;
  try {
    context.onEvent(event);
  } catch {
    /* listener errors are ignored */
  }
}

function progressFor(
  context: ExecutionContext,
  stepName: string,
): ((progress: number, message?: string) => void) | undefined {
  if (!context.onEvent) return undefined;
  return (progress, message) => notify(context, { type: "step.progress", stepName, progress, message });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
