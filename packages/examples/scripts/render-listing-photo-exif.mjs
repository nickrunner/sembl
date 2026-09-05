#!/usr/bin/env node
/**
 * Renders `data/listing-photo-exif.jpg`: the Sea Cabin sign from
 * `data/listing-photo.png`, re-encoded as a JPEG and stamped with the EXIF a
 * phone would have written — a capture time and the GPS position of a
 * cabin near Yachats, Oregon. Example 21 uses it when sharp is not
 * available at run time, so the fixture is reproducible from source.
 *
 *   node scripts/render-listing-photo-exif.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExif } from "@sembl/source-image";
import { SharpResizer } from "@sembl/source-image-sharp";

/** The metadata stamped onto the photo. Shared with example 21 by value, not import, so the script stays standalone. */
export const LISTING_PHOTO_EXIF = {
  takenAt: new Date("2025-06-14T16:12:30Z"),
  timeZoneOffset: "-07:00",
  gps: { latitude: 44.3114, longitude: -124.1049, altitude: 12 },
  make: "Apple",
  model: "iPhone 15 Pro",
  software: "17.5.1",
};

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data");
const png = new Uint8Array(readFileSync(resolve(dataDir, "listing-photo.png")));
const jpeg = await new SharpResizer({ maxEdge: 800, format: "image/jpeg", quality: 80 }).resize({ data: png, mediaType: "image/png" });
const stamped = writeExif(jpeg.data, LISTING_PHOTO_EXIF);

const out = resolve(dataDir, "listing-photo-exif.jpg");
writeFileSync(out, stamped);
console.log(`wrote ${out}: ${jpeg.width}×${jpeg.height}, ${stamped.length} bytes`);
