import { InMemoryAuditSink, Orchestrator } from "@mcp-orchestrator/core";
import { StateManager } from "@mcp-orchestrator/state";
import {
  InMemoryWorkflowAuditSink,
  WorkflowEngine,
  type ExecutionContext,
} from "@mcp-orchestrator/workflow";
import { filesystemDomain } from "./domains/filesystem.js";

export * from "./domains/filesystem.js";
export * from "./harness.js";

export interface ReferenceOrchestratorOptions {
  /** Sandbox root for the filesystem domain. Omit to skip that domain. */
  filesystemRoot?: string;
}

/** A fully-assembled orchestrator with state, workflows and audit wired up. */
export interface ReferenceOrchestrator {
  readonly orchestrator: Orchestrator;
  readonly state: StateManager;
  readonly workflows: WorkflowEngine;
  readonly toolAudit: InMemoryAuditSink;
  readonly workflowAudit: InMemoryWorkflowAuditSink;
}

/**
 * Wire the SDK packages into one working orchestrator: a state manager, an
 * audited tool registry, a workflow engine (using the orchestrator as its tool
 * caller) and the sandboxed filesystem domain. This is the reference for how the
 * previously-monolithic system is composed from the SDK's independent parts.
 */
export function createReferenceOrchestrator(
  options: ReferenceOrchestratorOptions = {},
): ReferenceOrchestrator {
  const state = new StateManager();
  const toolAudit = new InMemoryAuditSink();
  const workflowAudit = new InMemoryWorkflowAuditSink();

  // Late-bound so the orchestrator can delegate to the engine while the engine
  // uses the orchestrator as its tool caller (resolves the construction cycle).
  let engine: WorkflowEngine;
  const orchestrator = new Orchestrator({
    state,
    auditSinks: [toolAudit],
    workflows: {
      execute: (id, inputs, context) => engine.execute(id, inputs, context as ExecutionContext),
      executeDefinition: (definition, inputs, context) =>
        engine.executeDefinition(
          definition as Parameters<WorkflowEngine["executeDefinition"]>[0],
          inputs,
          context as ExecutionContext,
        ),
    },
  });
  engine = new WorkflowEngine({ tools: orchestrator, auditSinks: [workflowAudit] });

  if (options.filesystemRoot) {
    for (const tool of filesystemDomain(options.filesystemRoot)) orchestrator.registerTool(tool);
  }

  return { orchestrator, state, workflows: engine, toolAudit, workflowAudit };
}
