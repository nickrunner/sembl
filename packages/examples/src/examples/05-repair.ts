import { coerce } from "@sembl/core";
import type { Provider, TraceSink, TraceSpan } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok } from "../support/print.js";

export const title = "Repair: hand the model its rejected output and the reasons";

export async function run(): Promise<void> {
  const { provider } = demoProvider();

  // Break only the first answer; the repair call goes to the model untouched.
  let calls = 0;
  let turnsSeen = 0;
  const flaky: Provider = {
    // Passing this through is what makes the repair a real conversation.
    supportsHistory: provider.supportsHistory,
    async complete(request) {
      turnsSeen = request.history?.length ?? 0;
      const response = await provider.complete(request);
      calls += 1;
      if (calls === 1) {
        return { ...response, data: { ...response.data, name: 12345, sleeps: -4 } };
      }
      return response;
    },
  };
  note("The first answer is deliberately corrupted (name as a number, sleeps negative).");

  const events: string[] = [];
  const sink: TraceSink = {
    write(span: TraceSpan) {
      for (const e of span.events) {
        if (e.name === "repairAttempt") events.push(`repairAttempt ${JSON.stringify(e.attributes)}`);
      }
    },
  };

  heading("maxRepairAttempts: 1");
  const listing = await coerce<Listing>(sample("city-flat.txt"), {
    provider: flaky,
    schema: Listing,
    enumResolver,
    maxRepairAttempts: 1,
    traceSinks: [sink],
  });
  show("trace", events);
  show("Listing after repair", listing);
  ok(`${calls} model calls: the second one carried ${turnsSeen} prior turns — its own rejected answer, then the correction`);
}
