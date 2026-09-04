import { partialCoerceWithProvenance } from "@sembl/core";
import type { FieldProvenance } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, table } from "../support/print.js";

export const title = "Provenance: what to trust and what to flag for review";

/** The rule a review UI would use: a guess, or a value with no quote behind it, gets flagged. */
function needsReview(p: FieldProvenance | undefined): boolean {
  return !p || p.confidence === "low" || (p.confidence === "medium" && !p.evidence);
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();

  heading("A vague listing, pre-filled for a human to check");
  const text = `Lovely place by the water, probably fits a family or two couples.
Hot tub I think, definitely a kitchen. Somewhere near Bend. Not cheap but fair.`;
  note(text);
  const { data, provenance } = await partialCoerceWithProvenance<Listing>(text, {
    provider,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
  });

  table(
    Object.entries(data).map(([field, value]) => {
      const p = provenance[field];
      return {
        field,
        value: JSON.stringify(value),
        confidence: p?.confidence ?? "(none)",
        evidence: p?.evidence ?? "",
        review: needsReview(p) ? "FLAG" : "",
      };
    }),
  );
  note("Fields the input never mentioned are simply absent; `evidence` is absent when the value was inferred.");
}
