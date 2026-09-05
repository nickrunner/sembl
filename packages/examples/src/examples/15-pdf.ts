import { partialCoerceWithProvenance } from "@sembl/core";
import { pdfInfo, pdfSources, pdfToText, readPdfFile } from "@sembl/source-pdf";
import { Listing } from "../support/listing-runtime.js";
import { examplesPath } from "../support/env.js";
import { demoProvider, enumResolver } from "../support/provider.js";
import { heading, note, show, ok, warn, table } from "../support/print.js";

export const title = "PDF brochures, one source per page";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const pdf = await readPdfFile(examplesPath("data", "sea-cabin-brochure.pdf"));

  heading("@sembl/source-pdf: pdfInfo says whether there is a text layer to read");
  const info = await pdfInfo(pdf);
  show("info", { ...info, metadata: { ...info.metadata, created: info.metadata.created?.toISOString() } });
  if (!info.hasText) {
    warn("no text layer — a scan. Hand the pages to an image path instead of a text coercion.");
    return;
  }

  heading("pdfToText: lines rebuilt from glyph positions, table rows kept together, pages marked");
  const text = await pdfToText(pdf, { pages: [2] });
  show("page 2", text.split("\n").slice(0, 11).join("\n"));

  heading("pdfSources: the metadata as a short source, then one source per page");
  const sources = await pdfSources(pdf, "Brochure");
  note(sources.map((s) => `${s.label}: ${s.text.length} chars`).join(" · "));
  note("SEMBL's budget cuts long sources first, so a long brochure loses the tail of its longest pages, not its last pages.");

  const { data, provenance } = await partialCoerceWithProvenance<Listing>(sources, {
    provider,
    schema: Listing,
    enumResolver,
  });
  show("Listing", data);

  heading("Provenance names the page each value was read from");
  table(
    Object.entries(provenance).map(([field, p]) => ({
      field,
      confidence: p.confidence,
      source: p.source ?? "",
      evidence: (p.evidence ?? "").replace(/\s+/g, " ").slice(0, 48),
    })),
  );
  if (data.name && data.address?.zip && data.nightlyRate) {
    ok("the name and rate came off the cover and the address off the last page: the page labels carried through");
  }
}
