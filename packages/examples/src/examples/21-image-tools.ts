import { readFileSync } from "node:fs";
import { partialCoerceWithProvenance } from "@sembl/core";
import type { Source, TextSource } from "@sembl/core";
import { extractImages } from "@sembl/source-html";
import {
  extractExif,
  fetchImages,
  imageDimensions,
  imageSources,
  isMetadataSource,
  prepareImages,
  sniffImageType,
  writeExif,
} from "@sembl/source-image";
import type { ImageResizer } from "@sembl/source-image";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { examplesPath } from "../support/env.js";
import { heading, note, show, ok, warn, table } from "../support/print.js";

export const title = "Image tools: EXIF as evidence, a gallery downloaded, pixels resized";

/** The EXIF a phone would have written for the sign: a June morning, a cabin near Yachats. */
const PHOTO_EXIF = {
  takenAt: new Date("2025-06-14T16:12:30Z"),
  timeZoneOffset: "-07:00",
  gps: { latitude: 44.3114, longitude: -124.1049, altitude: 12 },
  make: "Apple",
  model: "iPhone 15 Pro",
  software: "17.5.1",
};

/**
 * `@sembl/source-image-sharp` when sharp's native binary works on this
 * machine, otherwise nothing — the example then falls back to the fixture
 * `scripts/render-listing-photo-exif.mjs` rendered.
 */
async function sharpResizer(): Promise<ImageResizer | undefined> {
  try {
    const { SharpResizer } = await import("@sembl/source-image-sharp");
    const resizer = new SharpResizer({ maxEdge: 800, format: "image/jpeg", quality: 80 });
    await resizer.resize({ data: readFileSync(examplesPath("data", "listing-photo.png")), mediaType: "image/png" });
    return resizer;
  } catch {
    return undefined;
  }
}

/** A JPEG of the sign with EXIF: built live through sharp, or read from the pre-rendered fixture. */
async function stampedPhoto(png: Uint8Array, resizer: ImageResizer | undefined): Promise<{ bytes: Uint8Array; how: string }> {
  if (resizer) {
    const jpeg = await resizer.resize({ data: png, mediaType: "image/png" });
    return { bytes: writeExif(jpeg.data, PHOTO_EXIF), how: `converted with sharp (${jpeg.width}×${jpeg.height}) and stamped with writeExif` };
  }
  return { bytes: new Uint8Array(readFileSync(examplesPath("data", "listing-photo-exif.jpg"))), how: "read from data/listing-photo-exif.jpg (sharp not available here)" };
}

function provenanceRows(provenance: Record<string, { confidence: string; source?: string; evidence?: string }>) {
  return Object.entries(provenance).map(([field, p]) => ({ field, confidence: p.confidence, source: p.source ?? "", evidence: p.evidence ?? "" }));
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const png = new Uint8Array(readFileSync(examplesPath("data", "listing-photo.png")));

  heading("What the file says about itself, from its header alone");
  show("sniffImageType", sniffImageType(png));
  show("imageDimensions", imageDimensions(png));

  heading("A JPEG copy with the EXIF a phone would write");
  const resizer = await sharpResizer();
  const photo = await stampedPhoto(png, resizer);
  note(photo.how);
  const exif = extractExif(photo.bytes);
  show("extractExif", { ...exif, takenAt: exif.takenAt?.toISOString(), modifiedAt: exif.modifiedAt?.toISOString() });

  heading("imageSources: the picture, and a text source with the facts the file carries");
  const sources = await imageSources(photo.bytes, "Listing photo");
  const metadata = sources.find(isMetadataSource) as TextSource;
  show(metadata.label ?? "metadata", metadata.text);
  note("The GPS line is where the camera stood, as a measurement. A sign in the frame could be the neighbour's; the coordinates cannot.");

  heading("Coerce a Listing from both, with provenance");
  const { data, provenance } = await partialCoerceWithProvenance<Listing>(sources, {
    provider,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
  });
  show("Listing", data);
  table(provenanceRows(provenance));
  const addressSource = provenance.address?.source ?? "";
  if (addressSource.includes("(photo metadata)")) ok("the address cites the metadata source: the GPS position backed it");
  else if (data.address?.city?.toLowerCase() === "yachats") note(`the sign states the address, so the model cited ${JSON.stringify(addressSource)}; the coordinates corroborate it`);
  else warn(`expected Yachats, got ${JSON.stringify(data.address)}`);

  heading("The metadata source alone: what the model does with coordinates");
  const fromGps = await partialCoerceWithProvenance<Listing>([metadata], {
    provider,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
    provenanceFields: ["address"],
  });
  show("Listing.address", fromGps.data.address);
  table(provenanceRows(fromGps.provenance));
  if (fromGps.data.address?.city?.toLowerCase() === "yachats") {
    ok("44.3114, -124.1049 is Yachats, Oregon, and provenance quotes the GPS line as the evidence");
  } else {
    note("The model will not geocode: the city comes back unknown at low confidence, with the GPS line quoted as evidence.");
    note("That is the right split. Reverse-geocode the coordinates in code; the provenance keeps them attached to the field for review.");
  }

  heading("fetchImages: the gallery extractImages harvested, served by an injected fetch");
  const html = sample("sea-cabin.html");
  const gallery = extractImages(html, { baseUrl: "https://coastal-stays.example/listing/sea-cabin" });
  show("extractImages", gallery.map((g) => g.url));
  // Stand in for the CDN: the hero is our stamped JPEG, the sauna is the PNG,
  // the hot tub redirects to a login page — the kind of thing a scrape hits.
  const served: Record<string, () => Response> = {
    "/photos/sea-cabin-hero.jpg": () => new Response(photo.bytes, { headers: { "content-type": "image/jpeg" } }),
    "/photos/sauna.jpg": () => new Response(png, { headers: { "content-type": "image/png" } }),
    "/photos/hot-tub-1600.jpg": () => new Response("<html>Please sign in</html>", { headers: { "content-type": "text/html" } }),
  };
  const localFetch = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    return served[path]?.() ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  const fetched = await fetchImages(gallery, { fetch: localFetch, max: 4 });
  table(fetched.sources.map((s) => ({ label: s.label, mediaType: "data" in s.image ? s.image.mediaType : "url", bytes: "data" in s.image ? (s.image.data as Uint8Array).length : "" })));
  show("skipped", fetched.skipped);
  ok(`${fetched.sources.length} images ready to pass beside htmlSources(html); ${fetched.skipped.length} skipped, nothing thrown`);

  heading("prepareImages: every image through a resizer, EXIF read before it is stripped");
  if (!resizer) {
    note("sharp is not available on this machine; prepareImages(sources, new NoopResizer()) would keep the bytes and still add the metadata sources.");
    return;
  }
  const { SharpResizer } = await import("@sembl/source-image-sharp");
  const small = new SharpResizer({ maxEdge: 512 });
  const prepared: Source[] = await prepareImages([...fetched.sources, { label: "Email", text: "The host says pets are welcome." }], small);
  table(
    prepared.map((s) => ({
      label: s.label,
      kind: "image" in s ? ("data" in s.image ? s.image.mediaType : "url") : "text",
      size: "image" in s && "data" in s.image ? `${imageDimensions(s.image.data as Uint8Array)?.width}×${imageDimensions(s.image.data as Uint8Array)?.height}, ${(s.image.data as Uint8Array).length} bytes` : "",
    })),
  );
  const hero = prepared[0];
  const heroMeta = prepared[1] as TextSource;
  if ("image" in hero && "data" in hero.image && !extractExif(hero.image.data as Uint8Array).hasExif && heroMeta.text.includes("44.311400")) {
    ok("the resized hero carries no EXIF, and its metadata source still has the GPS position read from the original");
  } else {
    warn("expected the EXIF to be stripped from the pixels and kept in the metadata source");
  }
}
