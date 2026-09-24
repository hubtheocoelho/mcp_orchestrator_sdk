import type { ToolCall, ToolResult } from "./types.js";

/** A single audited tool invocation. */
export interface AuditRecord {
  readonly call: ToolCall;
  readonly result: ToolResult;
  /** Present when the call threw rather than returning a failed result. */
  readonly error?: string;
  readonly recordedAt: number;
}

/** A destination for structured audit records. */
export interface AuditSink {
  record(entry: AuditRecord): void | Promise<void>;
}

/** Keeps audit records in memory; useful for tests and short-lived processes. */
export class InMemoryAuditSink implements AuditSink {
  private readonly entries: AuditRecord[] = [];

  record(entry: AuditRecord): void {
    this.entries.push(entry);
  }

  /** All records captured so far, in insertion order. */
  all(): readonly AuditRecord[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Writes one JSON line per record to the provided sink function (default: console). */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly write: (line: string) => void = (l) => console.log(l)) {}

  record(entry: AuditRecord): void {
    this.write(JSON.stringify(entry));
  }
}
