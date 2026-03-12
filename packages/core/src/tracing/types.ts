/**
 * A discrete event within a trace span.
 */
export interface TraceEvent {
  /** Event name */
  name: string;
  /** Timestamp */
  timestamp: number;
  /** Arbitrary attributes */
  attributes?: Record<string, unknown>;
}

/**
 * A span representing a unit of work in the coercion pipeline.
 */
export interface TraceSpan {
  /** Unique span ID */
  id: string;
  /** Human-readable name */
  name: string;
  /** Start timestamp */
  startTime: number;
  /** End timestamp (set when span completes) */
  endTime?: number;
  /** Events recorded during this span */
  events: TraceEvent[];
  /** Arbitrary attributes */
  attributes?: Record<string, unknown>;
  /** Parent span ID, if nested */
  parentId?: string;
}

/**
 * Sink that receives completed trace spans.
 */
export interface TraceSink {
  /** Called when a span is completed */
  write(span: TraceSpan): void;
}

/**
 * Context for tracing within a coercion call.
 */
export interface TraceContext {
  /** Start a new span */
  startSpan(name: string, attributes?: Record<string, unknown>): TraceSpan;
  /** End a span and dispatch to sinks */
  endSpan(span: TraceSpan): void;
  /** Add an event to the current span */
  addEvent(span: TraceSpan, name: string, attributes?: Record<string, unknown>): void;
}
