import { describeOrientation } from "./exif.js";
import type { ImageMetadata } from "./exif.js";
import { imageTypeName } from "./sniff.js";

/** The suffix appended to an image's label to name its metadata source. */
export const METADATA_LABEL_SUFFIX = " (photo metadata)";

/** The label of the text source that carries an image's metadata. */
export function metadataLabel(imageLabel: string): string {
  return `${imageLabel}${METADATA_LABEL_SUFFIX}`;
}

/**
 * Render what the headers say as text a model can read and provenance can
 * quote. One fact per line, only the facts that exist, and a first line
 * saying where they came from — the file, not the picture — so the model
 * treats a GPS position as a measurement rather than something it saw.
 *
 * ```
 * Facts recorded in the image file's headers (EXIF), not read from the picture:
 * Taken: 2025-06-14 09:12:30 (camera clock, UTC-07:00)
 * GPS position of the camera: 44.311400, -124.104900 (latitude, longitude, decimal degrees WGS84); altitude 12 m above sea level
 * Orientation: 6 (rotated 90° clockwise to display (stored on its side))
 * Camera: Apple iPhone 15 Pro
 * Software: 17.5.1
 * Dimensions: 4032×3024 pixels (JPEG)
 * ```
 */
export function renderImageMetadata(metadata: ImageMetadata): string {
  const lines: string[] = ["Facts recorded in the image file's headers (EXIF), not read from the picture:"];

  if (metadata.takenAtLocal) {
    const zone = metadata.timeZoneOffset ? `UTC${metadata.timeZoneOffset}` : "time zone not recorded";
    lines.push(`Taken: ${metadata.takenAtLocal} (camera clock, ${zone})`);
  }
  if (metadata.gps) {
    const { latitude, longitude, altitude } = metadata.gps;
    let line = `GPS position of the camera: ${latitude.toFixed(6)}, ${longitude.toFixed(6)} (latitude, longitude, decimal degrees WGS84)`;
    if (altitude !== undefined) {
      line += `; altitude ${Math.abs(altitude).toFixed(altitude % 1 === 0 ? 0 : 1)} m ${altitude < 0 ? "below" : "above"} sea level`;
    }
    lines.push(line);
  }
  if (metadata.orientation !== undefined && metadata.orientation !== 1) {
    lines.push(`Orientation: ${metadata.orientation} (${describeOrientation(metadata.orientation)})`);
  }
  const camera = [metadata.make, metadata.model].filter((s): s is string => !!s);
  if (camera.length > 0) {
    // "Apple" + "Apple iPhone" would read twice; keep the model when it already names the make.
    const name = camera.length === 2 && camera[1].toLowerCase().startsWith(camera[0].toLowerCase()) ? camera[1] : camera.join(" ");
    lines.push(`Camera: ${name}`);
  }
  if (metadata.software) lines.push(`Software: ${metadata.software}`);
  if (metadata.width && metadata.height) {
    const format = metadata.mediaType ? ` (${imageTypeName(metadata.mediaType)})` : "";
    lines.push(`Dimensions: ${metadata.width}×${metadata.height} pixels${format}`);
  } else if (metadata.exifWidth && metadata.exifHeight) {
    lines.push(`Dimensions: ${metadata.exifWidth}×${metadata.exifHeight} pixels (from EXIF)`);
  }
  if (metadata.description) lines.push(`Description: ${oneLine(metadata.description)}`);
  if (metadata.userComment) lines.push(`Comment: ${oneLine(metadata.userComment)}`);

  if (!metadata.takenAtLocal && !metadata.gps) {
    lines.push(
      metadata.hasExif
        ? "No capture date or GPS position is recorded in the file."
        : "The file carries no EXIF: no capture date, GPS position or camera is recorded.",
    );
  }
  return lines.join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
