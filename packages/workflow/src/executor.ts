import { randomUUID } from "node:crypto";
import { NoopTracer, OrchestratorAbortError, type JsonObject, type Tracer } from "@mcp-orchestrator/core";
import type { WorkflowAuditSink } from "./audit.js";
import type { CheckpointStore, WorkflowCheckpoint } from "./checkpoint.js";
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

    const workflowSpan = tracer.startSpan("workflow.execute", {
      "workflow.id": definition.id,
      "run.id": runId,
    });

    const input = this.resolveInputs(definition, rawInputs);
    const scope: ExpressionScope = restoredScope ?? { input, steps: {} };
    const steps: StepResult[] = [];

    await this.emit({ type: "run-start", runId, workflowId: definition.id, at: Date.now() });

    let failure: string | undefined;

    for (let i = startIndex; i < definition.steps.length; i++) {
      const step = definition.steps[i]!;

      if (context.signal?.aborted) {
        failure = `Workflow aborted`;
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

      const stepSpan = tracer.startSpan(`workflow.step.${step.id}`, {
        "workflow.id": definition.id,
        "step.name": step.id,
        "tool.name": step.tool,
      });

      const result = await this.runStep(step, scope, context, runId);
      steps.push(result);

      stepSpan.setAttribute("workflow.id", definition.id);
      stepSpan.setAttribute("step.name", step.id);
      stepSpan.setAttribute("tool.name", step.tool);
      stepSpan.setAttribute("step.status", result.status);
      stepSpan.setAttribute("step.duration_ms", result.durationMs);

      if (result.status === "failed" && result.error) {
        stepSpan.recordException(new Error(result.error));
      }
      stepSpan.end();

      await this.emit({ type: "step-complete", runId, step: result, at: Date.now() });

      const policy = step.onError ?? step.on_failure;

      if (result.status === "success") {
        scope.steps[step.id] = { output: result.output };
        if (context.checkpointStore) {
          await context.checkpointStore.save({
            workflowId: definition.id,
            stepIndex: i + 1,
            state: JSON.parse(JSON.stringify(scope)),
            timestamp: Date.now(),
          });
        }
        if (step.stop_when && evaluateCondition(step.stop_when, scope)) break;
      } else if (policy === "skip") {
        // "skip" continues past a failed step without failing the workflow
      } else if (policy === "continue") {
        // "continue" continues past a failed step, but reports failure at the end
        failure = failure ?? `Step "${step.id}" failed: ${result.error}`;
        scope.steps[step.id] = { output: result.output };
      } else {
        // "fail", and "retry" once exhausted, abort the run.
        failure = `Step "${step.id}" failed: ${result.error}`;
        if (context.checkpointStore) {
          await context.checkpointStore.save({
            workflowId: definition.id,
            stepIndex: i,
            state: JSON.parse(JSON.stringify(scope)),
            timestamp: Date.now(),
          });
        }
        break;
      }
    }

    if (failure) {
      workflowSpan.recordException(new Error(failure));
    }
    workflowSpan.end();

    const outputs = failure && definition.steps.some(s => s.onError !== "continue" && s.on_failure !== "continue")
      ? {}
      : this.resolveOutputs(definition, scope);

    const result: WorkflowResult = {
      workflowId: definition.id,
      runId,
      ok: !failure,
      outputs,
      steps,
      durationMs: Date.now() - startedAt,
      error: failure,
    };

    await this.emit({ type: "run-complete", runId, result, at: Date.now() });
    return result;
  }

  /**
   * Resume workflow execution from the last saved checkpoint in `checkpointStore`.
   */
  async resume(
    definition: WorkflowDefinition,
    checkpointStore: CheckpointStore,
    context: ExecutionContext = {},
  ): Promise<WorkflowResult> {
    const checkpoint = await checkpointStore.load(definition.id);
    if (!checkpoint) {
      return this.execute(definition, {}, { ...context, checkpointStore });
    }
    return this.execute(
      definition,
      checkpoint.state.input,
      { ...context, checkpointStore },
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
      if (context.signal?.aborted) {
        throw new OrchestratorAbortError();
      }

      for (const toolName of step.parallel) {
        await this.emit({
          type: "step-start",
          runId,
          stepId: `${step.id}.${toolName}`,
          toolId: toolName,
          at: Date.now(),
        });
      }

      const tasks = step.parallel.map(async (toolName, idx) => {
        if (context.signal?.aborted) {
          throw new OrchestratorAbortError();
        }
        const outcome = await this.tools.callTool(toolName, params, {
          caller: context.caller,
          callId: `${runId}:${step.id}:${toolName}:${idx}`,
          signal: context.signal,
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
            durationMs: 0,
          },
          at: Date.now(),
        });

        if (context.signal?.aborted) {
          throw new OrchestratorAbortError();
        }

        return { toolName, outcome };
      });

      let results: Array<{ toolName: string; outcome: { ok: boolean; output?: unknown; error?: string } }>;

      if (policy === "continue") {
        const settled = await Promise.allSettled(tasks);
        results = settled.map((s, idx) => {
          if (s.status === "fulfilled") {
            return s.value;
          }
          const err = s.reason;
          if (err instanceof OrchestratorAbortError || err?.name === "AbortError") {
            throw err;
          }
          return {
            toolName: step.parallel![idx]!,
            outcome: { ok: false, error: err?.message ?? String(err) },
          };
        });
      } else {
        results = await Promise.all(tasks);
      }

      const anyFailed = results.find((r) => !r.outcome.ok);
      const aggregatedOutputs = results.map((r) => r.outcome.output);

      if (anyFailed && policy !== "continue") {
        return {
          id: step.id,
          toolId: step.tool,
          status: "failed",
          error: anyFailed.outcome.error ?? "Parallel execution failed",
          output: aggregatedOutputs,
          attempts: 1,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        id: step.id,
        toolId: step.tool,
        status: anyFailed ? "failed" : "success",
        error: anyFailed ? anyFailed.outcome.error : undefined,
        output: aggregatedOutputs,
        attempts: 1,
        durationMs: Date.now() - startedAt,
      };
    }

    let lastError = "unknown error";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const outcome = await this.tools.callTool(step.tool, params, {
        caller: context.caller,
        callId: `${runId}:${step.id}:${attempt}`,
        signal: context.signal,
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
      if (attempt < maxAttempts && delayMs > 0) await delay(delayMs);
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

  private async emit(event: Parameters<WorkflowAuditSink["record"]>[0]): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.record(event)));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
