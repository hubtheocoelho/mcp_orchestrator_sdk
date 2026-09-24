import { err, ok, type JsonObject, type Result, type ValidationError } from "@mcp-orchestrator/core";
import type { WorkflowAuditSink } from "./audit.js";
import { WorkflowExecutor } from "./executor.js";
import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from "./schema.js";
import type { ExecutionContext, ToolCaller, WorkflowResult } from "./types.js";

/** Thrown when referencing a workflow id that has not been defined. */
export class WorkflowNotFoundError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow not found: ${workflowId}`);
    this.name = "WorkflowNotFoundError";
  }
}

export interface WorkflowEngineOptions {
  tools: ToolCaller;
  auditSinks?: WorkflowAuditSink[];
}

/**
 * Registry + runtime for workflows. Validates and stores definitions, then runs
 * them through a {@link WorkflowExecutor}. Satisfies core's structural
 * WorkflowRunner, so it can be handed to an Orchestrator as `workflows`.
 */
export class WorkflowEngine {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  private readonly executor: WorkflowExecutor;

  constructor(options: WorkflowEngineOptions) {
    this.executor = new WorkflowExecutor({ tools: options.tools, auditSinks: options.auditSinks });
  }

  /** Validate, then register (or replace) a workflow definition. */
  define(definition: WorkflowDefinitionInput): WorkflowDefinition {
    const parsed = workflowDefinitionSchema.parse(definition);
    this.definitions.set(parsed.id, parsed);
    return parsed;
  }

  /** Validate a definition without registering it, returning a Result. */
  validate(definition: WorkflowDefinitionInput): Result<WorkflowDefinition, ValidationError[]> {
    const parsed = workflowDefinitionSchema.safeParse(definition);
    if (parsed.success) return ok(parsed.data);
    const errors: ValidationError[] = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return err(errors);
  }

  has(workflowId: string): boolean {
    return this.definitions.has(workflowId);
  }

  get(workflowId: string): WorkflowDefinition | undefined {
    return this.definitions.get(workflowId);
  }

  list(): WorkflowDefinition[] {
    return [...this.definitions.values()];
  }

  /** Execute a previously-defined workflow. */
  async execute(
    workflowId: string,
    inputs: JsonObject = {},
    context?: ExecutionContext,
  ): Promise<WorkflowResult> {
    const definition = this.definitions.get(workflowId);
    if (!definition) throw new WorkflowNotFoundError(workflowId);
    return this.executor.execute(definition, inputs, context ?? {});
  }
}
