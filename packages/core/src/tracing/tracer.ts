import type { TraceSpan, TraceSink, TraceContext } from "./types.js";

let spanCounter = 0;

function generateSpanId(): string {
  return `span_${++spanCounter}_${Date.now()}`;
}

/**
 * Tracer implementation that creates spans, records events, and dispatches to sinks.
 */
export class Tracer implements TraceContext {
  private sinks: TraceSink[];

  constructor(sinks?: TraceSink[]) {
    this.sinks = sinks ?? [];
  }

  startSpan(
    name: string,
    attributes?: Record<string, unknown>,
    parent?: TraceSpan,
  ): TraceSpan {
    return {
      id: generateSpanId(),
      name,
      startTime: Date.now(),
      events: [],
      attributes,
      parentId: parent?.id,
    };
  }

  endSpan(span: TraceSpan): void {
    span.endTime = Date.now();
    for (const sink of this.sinks) {
      sink.write(span);
    }
  }

  addEvent(
    span: TraceSpan,
    name: string,
    attributes?: Record<string, unknown>,
  ): void {
    span.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
  }
}
