import { partialCoerce } from "@sembl/core";
import type { TraceSink, TraceSpan } from "@sembl/core";
import { htmlSources, pageToText, extractImages } from "@sembl/source-html";
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

  heading("htmlSources: the structured data as its own source, the text as another");
  const sources = htmlSources(html, "Listing page");
  note(sources.map((s) => `${s.label}: ${s.text.length} chars`).join(" · "));
  heading("extractImages: the gallery, junk and duplicates dropped");
  show("images", extractImages(html, { baseUrl: "https://coastal-stays.example/listing/sea-cabin" }));

  heading("maxInputChars: cut the page, keep the structured source whole");
  let truncation: unknown;
  const sink: TraceSink = {
    write(span: TraceSpan) {
      const e = span.events.find((ev) => ev.name === "inputTruncated");
      if (e) truncation = e.attributes;
    },
  };
  const listing = await partialCoerce<Listing>(sources, {
    provider,
    schema: Listing,
    enumResolver,
    maxInputChars: 1800,
    traceSinks: [sink],
  });
  show("inputTruncated event", truncation);
  show("Listing (from 1,800 characters of a 2,100-character page)", listing);
  if (listing.name && listing.address?.zip) ok("name and address survived the cut: the structured source is short, so the budget only cut the text");
}
