import { coerceMany } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, ok, table } from "../support/print.js";

export const title = "coerceMany: a batch with a concurrency cap and one settled result per input";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const files = ["sea-cabin.txt", "city-flat.txt", "barn.txt", "lakehouse.txt", "vrbo-sea-cabin.txt"];

  heading(`${files.length} listings, concurrency 2, partial mode with clamp`);
  note("The first item runs alone to prime the provider's prompt cache; the rest fan out.");
  const started = Date.now();
  const results = await coerceMany<Partial<Listing>>(
    files.map((f) => ({ label: f, text: sample(f) })),
    {
      provider,
      schema: Listing,
      enumResolver,
      mode: "partialCoerce",
      onInvalidField: "clamp",
      concurrency: 2,
      onItem: (r) => console.log(`  ${r.ok ? "✓" : "✗"} ${files[r.index]} (${Date.now() - started}ms)`),
    },
  );

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
          }
        : { input: files[r.index], name: `ERROR: ${(r.error as Error).message.split("\n")[0]}` },
    ),
  );
  ok(`${results.filter((r) => r.ok).length}/${results.length} ok; a failure would appear as its own row, not as a rejected batch`);
}
