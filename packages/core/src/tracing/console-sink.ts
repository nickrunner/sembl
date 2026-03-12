import type { TraceSpan, TraceSink } from "./types.js";

/**
 * Default trace sink that writes spans to the console.
 */
export class ConsoleSink implements TraceSink {
  write(span: TraceSpan): void {
    const duration = span.endTime ? span.endTime - span.startTime : "?";
    const prefix = span.parentId ? "  " : "";
    console.log(
      `${prefix}[trace] ${span.name} (${duration}ms)`,
      span.attributes ?? "",
    );
    for (const event of span.events) {
      console.log(
        `${prefix}  [event] ${event.name}`,
        event.attributes ?? "",
      );
    }
  }
}
