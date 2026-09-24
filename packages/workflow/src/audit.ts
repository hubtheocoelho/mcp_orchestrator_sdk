import type { StepResult, WorkflowResult } from "./types.js";

/** A structured event emitted during a workflow run. */
export type WorkflowAuditEvent =
  | { readonly type: "run-start"; readonly runId: string; readonly workflowId: string; readonly at: number }
  | { readonly type: "step-start"; readonly runId: string; readonly stepId: string; readonly toolId: string; readonly at: number }
  | { readonly type: "step-complete"; readonly runId: string; readonly step: StepResult; readonly at: number }
  | { readonly type: "run-complete"; readonly runId: string; readonly result: WorkflowResult; readonly at: number };

/** A destination for workflow audit events. */
export interface WorkflowAuditSink {
  record(event: WorkflowAuditEvent): void | Promise<void>;
}

/** Collects workflow audit events in memory (tests, inspection). */
export class InMemoryWorkflowAuditSink implements WorkflowAuditSink {
  private readonly events: WorkflowAuditEvent[] = [];

  record(event: WorkflowAuditEvent): void {
    this.events.push(event);
  }

  all(): readonly WorkflowAuditEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** Writes one JSON line per event (JSONL trail); defaults to console. */
export class JsonlWorkflowAuditSink implements WorkflowAuditSink {
  constructor(private readonly write: (line: string) => void = (l) => console.log(l)) {}

  record(event: WorkflowAuditEvent): void {
    this.write(JSON.stringify(event));
  }
}
