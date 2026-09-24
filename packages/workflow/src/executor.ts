import { randomUUID } from "node:crypto";
import type { JsonObject } from "@mcp-orchestrator/core";
import type { WorkflowAuditSink } from "./audit.js";
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
}

/**
 * Runs a validated {@link WorkflowDefinition} step by step against a
 * {@link ToolCaller}: applies input defaults, evaluates `when`/`stop_when`
 * gates, interpolates params, enforces on-failure policies (fail/skip/retry)
 * and emits an audit event for each stage.
 */
export class WorkflowExecutor {
  private readonly tools: ToolCaller;
  private readonly sinks: WorkflowAuditSink[];

  constructor(options: ExecutorOptions) {
    this.tools = options.tools;
    this.sinks = options.auditSinks ?? [];
  }

  async execute(
    definition: WorkflowDefinition,
    rawInputs: JsonObject = {},
    context: ExecutionContext = {},
  ): Promise<WorkflowResult> {
    const runId = context.runId ?? randomUUID();
    const startedAt = Date.now();
    const input = this.resolveInputs(definition, rawInputs);
    const scope: ExpressionScope = { input, steps: {} };
    const steps: StepResult[] = [];

    await this.emit({ type: "run-start", runId, workflowId: definition.id, at: Date.now() });

    let failure: string | undefined;

    for (const step of definition.steps) {
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
      const result = await this.runStep(step, scope, context, runId);
      steps.push(result);
      await this.emit({ type: "step-complete", runId, step: result, at: Date.now() });

      if (result.status === "success") {
        scope.steps[step.id] = { output: result.output };
        if (step.stop_when && evaluateCondition(step.stop_when, scope)) break;
      } else if (step.on_failure !== "skip") {
        // "fail", and "retry" once its attempts are exhausted, abort the run.
        failure = `Step "${step.id}" failed: ${result.error}`;
        break;
      }
      // Only on_failure "skip" continues past a failed step.
    }

    const outputs = failure ? {} : this.resolveOutputs(definition, scope);
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

  private async runStep(
    step: WorkflowStep,
    scope: ExpressionScope,
    context: ExecutionContext,
    runId: string,
  ): Promise<StepResult> {
    const params = interpolateParams(step.params as JsonObject, scope);
    const maxAttempts = step.on_failure === "retry" ? Math.max(1, step.retry?.max ?? 1) : 1;
    const delayMs = step.retry?.delayMs ?? 0;
    const startedAt = Date.now();

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
