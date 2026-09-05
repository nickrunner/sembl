import { coerceMany } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, ok, table } from "../support/print.js";

export const title = "coerceMany: streamed inputs, an eager cache warm-up, and one settled result per input";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const files = ["sea-cabin.txt", "city-flat.txt", "barn.txt", "lakehouse.txt", "vrbo-sea-cabin.txt"];

  heading(`${files.length} listings, concurrency 2, partial mode with clamp`);
  note("Inputs arrive from an async generator, as if fetched one by one. primeCache: \"eager\" warms the");
  note("provider's prompt cache with one small call while the first pages are still loading.");
  const started = Date.now();
  async function* fetchPages() {
    for (const f of files) {
      await new Promise((r) => setTimeout(r, 150)); // a pretend fetch
      yield { label: f, text: sample(f) };
    }
  }
  const results = await coerceMany<Partial<Listing>>(fetchPages(), {
    provider,
    schema: Listing,
    enumResolver,
    mode: "partialCoerce",
    onInvalidField: "clamp",
    concurrency: 2,
    primeCache: "eager",
    onItem: (r) => console.log(`  ${r.ok ? "✓" : "✗"} ${files[r.index]} (${Date.now() - started}ms, ${r.usage.promptTokens} prompt tokens)`),
  });

  heading("Results, in input order");
  table(
    results.map((r) =>
      r.ok
        ? {
            input: files[r.index],
            name: r.data.name,
            sleeps: r.data.sleeps,
            rate: r.data.nightlyRate !== undefined ? `${r.data.nightlyRate} ${r.data.currency ?? ""}` : "",
            amenities: (r.data.amenities ?? []).join(", "),
            issues: r.issues.length,
            tokens: r.usage.totalTokens,
          }
        : { input: files[r.index], name: `ERROR: ${(r.error as Error).message.split("\n")[0]}` },
    ),
  );
  ok(`${results.filter((r) => r.ok).length}/${results.length} ok; a failure would appear as its own row, not as a rejected batch`);
}
