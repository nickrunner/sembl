import { coerceWithProvenance } from "@sembl/core";
import { docxSources, docxToText, extractDocxMetadata, readDocxFile } from "@sembl/source-docx";
import { Listing } from "../support/listing-runtime.js";
import { examplesPath } from "../support/env.js";
import { demoProvider, enumResolver } from "../support/provider.js";
import { heading, note, show, ok, warn, table } from "../support/print.js";

export const title = "Word documents: structure kept, one source per section";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const data = await readDocxFile(examplesPath("data", "property-handover-notes.docx"));

  heading("@sembl/source-docx: headings, lists, tables and footnotes survive; formatting does not");
  const text = await docxToText(data);
  note(`${data.length} bytes of .docx → ${text.length} characters of text`);
  show("first 24 lines", text.split("\n").slice(0, 24).join("\n"));

  heading("extractDocxMetadata: the core properties");
  show("metadata", await extractDocxMetadata(data));

  heading("docxSources: one labelled source per top-level heading");
  const sources = await docxSources(data, "Handover notes");
  note(sources.map((s) => `${s.label}: ${s.text.length} chars`).join(" · "));
  show("the Utilities section", sources.find((s) => s.label?.endsWith("Utilities"))?.text);

  heading("coerceWithProvenance: which section each value was read from");
  const { data: listing, provenance } = await coerceWithProvenance<Listing>(sources, {
    provider,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
  });
  show("Listing", listing);
  table(
    Object.entries(provenance).map(([field, p]) => ({
      field,
      confidence: p.confidence,
      source: p.source ?? "",
      evidence: p.evidence ?? "",
    })),
  );

  const amenitiesFrom = provenance.amenities?.source ?? "";
  if (listing.amenities?.includes("sauna") && amenitiesFrom.includes("Amenities")) {
    ok("the amenities were read from the Amenities section, and the section label says so");
  } else {
    warn("expected the amenities to be traced to the Amenities section");
  }
  if (listing.petsAllowed === false) ok("petsAllowed is false: the rule survived with the bold and the tracked changes gone");
}
