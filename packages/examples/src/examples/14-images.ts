import { existsSync, readFileSync } from "node:fs";
import { partialCoerceWithProvenance, renderSources, toSources } from "@sembl/core";
import type { ImageSource, Provider } from "@sembl/core";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver } from "../support/provider.js";
import { examplesPath } from "../support/env.js";
import { heading, note, show, ok, warn, table } from "../support/print.js";

export const title = "Image sources: a listing read from a photo";

/**
 * `data/listing-photo.png` is a sign for the Sea Cabin, rendered by
 * `scripts/render-listing-photo.mjs`. Drop a real photo of a listing at
 * `data/listing-photo.jpg` to try one of your own.
 */
function listingPhoto(): ImageSource | undefined {
  const own = examplesPath("data", "listing-photo.jpg");
  if (existsSync(own)) {
    return { label: "Listing photo", image: { data: new Uint8Array(readFileSync(own)), mediaType: "image/jpeg" } };
  }
  const rendered = examplesPath("data", "listing-photo.png");
  if (existsSync(rendered)) {
    return { label: "Listing photo", image: { data: new Uint8Array(readFileSync(rendered)), mediaType: "image/png" } };
  }
  return undefined;
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const photo = listingPhoto();
  if (!photo) {
    warn("no photo found: drop one at packages/examples/data/listing-photo.jpg, or run `node scripts/render-listing-photo.mjs`");
    return;
  }

  heading("An image is a source like any other");
  note("It renders as a placeholder in the text form of the input, and travels as a content block beside it.");
  show("renderSources", renderSources(toSources([{ label: "Email", text: "The host says pets are welcome." }, photo])));

  heading("Coerce a Listing from the photo, with provenance");
  const { data, provenance } = await partialCoerceWithProvenance<Listing>(
    [photo, { label: "Email", text: "The host says pets are welcome." }],
    { provider, schema: Listing, enumResolver, onInvalidField: "drop" },
  );
  show("Listing", data);
  note("For a value read from an image, evidence says where in the image it appears rather than quoting it.");
  table(
    Object.entries(provenance).map(([field, p]) => ({
      field,
      confidence: p.confidence,
      source: p.source ?? "",
      evidence: p.evidence ?? "",
    })),
  );
  if (data.name?.toLowerCase().includes("sea cabin")) ok("the name was read off the sign");
  else warn(`expected the name from the sign, got ${JSON.stringify(data.name)}`);

  heading("A provider that cannot see images is refused before any call");
  const textOnly: Provider = { async complete() { return { data: {} }; } };
  try {
    await partialCoerceWithProvenance(photo, { provider: textOnly, schema: Listing });
    warn("expected a RangeError");
  } catch (error) {
    if (error instanceof RangeError) ok(`RangeError: ${error.message.split(". ")[0]}`);
    else throw error;
  }
}
