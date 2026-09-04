import { partialCoerce } from "@sembl/core";
import type { TraceSink, TraceSpan } from "@sembl/core";
import { htmlSource, pageToText } from "@sembl/source-html";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, show, ok } from "../support/print.js";

export const title = "HTML pages and the input budget";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const html = sample("sea-cabin.html");

  heading("@sembl/source-html: metadata and JSON-LD first, boilerplate gone");
  const text = pageToText(html);
  note(`${html.length} characters of HTML → ${text.length} of text`);
  show("first 12 lines", text.split("\n").slice(0, 12).join("\n"));

  heading("maxInputChars: cut the page, keep the structured head");
  let truncation: unknown;
  const sink: TraceSink = {
    write(span: TraceSpan) {
      const e = span.events.find((ev) => ev.name === "inputTruncated");
      if (e) truncation = e.attributes;
    },
  };
  const listing = await partialCoerce<Listing>(htmlSource(html, "Listing page"), {
    provider,
    schema: Listing,
    enumResolver,
    maxInputChars: 900,
    traceSinks: [sink],
  });
  show("inputTruncated event", truncation);
  show("Listing (from the first 900 characters)", listing);
  if (listing.name && listing.address?.zip) ok("name and address survived the cut: they were in the JSON-LD at the top");
}
