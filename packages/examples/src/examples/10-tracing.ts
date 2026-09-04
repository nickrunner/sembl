import { coerce, ConsoleSink } from "@sembl/core";
import type { TraceSink, TraceSpan, ProviderUsage } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show } from "../support/print.js";

export const title = "Tracing: every span and event, and a custom sink that adds up usage";

/** Sums token usage off the llmCall spans — the shape an OpenTelemetry bridge would take. */
class UsageSink implements TraceSink {
  calls = 0;
  prompt = 0;
  completion = 0;
  cacheRead = 0;
  write(span: TraceSpan): void {
    if (span.name !== "llmCall") return;
    const usage = span.events.find((e) => e.name === "responseReceived")?.attributes?.usage as ProviderUsage | undefined;
    if (!usage) return;
    this.calls += 1;
    this.prompt += usage.promptTokens;
    this.completion += usage.completionTokens;
    this.cacheRead += usage.cacheReadTokens ?? 0;
  }
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const usage = new UsageSink();

  heading("ConsoleSink prints the span tree as it closes");
  note("Spans: prepareInput, resolveEnums, buildPrompt, buildJsonSchema, llmCall, validate, then the root. Events hang off each.");
  await coerce<Listing>(sample("city-flat.txt"), {
    provider,
    schema: Listing,
    enumResolver,
    maxInputChars: 5000,
    traceSinks: [new ConsoleSink(), usage],
  });

  heading("A custom sink can account for tokens");
  show("usage", { calls: usage.calls, promptTokens: usage.prompt, completionTokens: usage.completion, cacheReadTokens: usage.cacheRead });
  note("Replayed calls report the usage that was recorded when they first ran.");
}
