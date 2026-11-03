/**
 * Pluggable tracing interfaces for the orchestration engine.
 *
 * These are intentionally minimal – they mirror a tiny subset of the
 * OpenTelemetry Tracing API so that an `@opentelemetry/api` adapter is trivial,
 * but the core package has zero dependency on OTel.
 */

/** A single unit of work in a trace. */
export interface Span {
  setAttribute(key: string, value: unknown): void;
  recordException(err: unknown): void;
  end(): void;
}

/** Creates spans. Implementations may wrap OTel, Langfuse, Datadog, etc. */
export interface Tracer {
  startSpan(name: string, attributes?: Record<string, unknown>): Span;
}

/** A tracer that does nothing – used as the default so call-sites never need null-checks. */
class _NoopSpan implements Span {
  setAttribute(_key: string, _value: unknown): void { /* noop */ }
  recordException(_err: unknown): void { /* noop */ }
  end(): void { /* noop */ }
}

class _NoopTracer implements Tracer {
  startSpan(_name: string, _attributes?: Record<string, unknown>): Span {
    return new _NoopSpan();
  }
}

/** Singleton NoopTracer instance – the default when no tracer is configured. */
export const NoopTracer: Tracer = new _NoopTracer();
