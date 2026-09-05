import { partialCoerce } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok, warn } from "../support/print.js";

export const title = "instructions: a per-call hint the schema can't carry";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const base = { provider, schema: Listing, enumResolver };

  heading("Without a hint");
  note("The barn is priced in pounds. The schema requires an ISO 4217 code but says nothing about symbols.");
  const plain = await partialCoerce<Listing>(sample("barn.txt"), base);
  show("nightlyRate / currency", { nightlyRate: plain.nightlyRate, currency: plain.currency ?? "(absent)" });

  heading("With instructions");
  const hints = [
    "Infer the currency from its symbol: $ is USD, € is EUR, £ is GBP.",
    "Guest counts exclude infants.",
  ];
  note(hints.map((h) => `- ${h}`).join("\n"));
  const hinted = await partialCoerce<Listing>(sample("barn.txt"), { ...base, instructions: hints });
  show("nightlyRate / currency", { nightlyRate: hinted.nightlyRate, currency: hinted.currency ?? "(absent)" });

  if (hinted.currency === "GBP") ok("the hint reached the model as an instruction, not as data");
  else warn("the model did not act on the hint this time — instructions guide, they do not force");
  note("Hints live in the system prompt. A hint pasted into a source would be ignored on purpose: sources are data.");
}
