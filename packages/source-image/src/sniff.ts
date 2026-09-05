import type { ImageMediaType } from "@sembl/core";
import { IMAGE_MEDIA_TYPES } from "@sembl/core";

/**
 * Formats this package recognises but no bundled provider accepts. They
 * are detected so the failure can name them: "this is a HEIC" is a far
 * better message than "not an image", and points at the fix (convert it,
 * which `@sembl/source-image-sharp` does where its libvips can).
 */
export type UnsupportedImageType = "image/heic" | "image/heif" | "image/avif" | "image/tiff" | "image/bmp";

/** Every format {@link detectImageType} can name. */
export type DetectedImageType = ImageMediaType | UnsupportedImageType;

const ASCII = (bytes: Uint8Array, start: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(start, start + length));

/** The `ftyp` brands that mean HEIC (HEVC-coded) rather than another HEIF flavour. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
/** The `ftyp` brands of the wider HEIF family, including the mif1/msf1 structural brands. */
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif", "heix"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * The format of an image from its magic bytes, including the formats no
 * provider accepts. `undefined` when the bytes are not a recognised image.
 *
 * Only the header is read — nothing is decoded — so this is safe to call
 * on anything, including a download that turned out to be an HTML error
 * page.
 */
export function detectImageType(bytes: Uint8Array): DetectedImageType | undefined {
  if (bytes.length < 12) return undefined;
  const b = bytes;

  // JPEG: SOI marker.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";

  // PNG: the eight-byte signature.
  if (b[0] === 0x89 && ASCII(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }

  // GIF87a / GIF89a.
  if (ASCII(b, 0, 3) === "GIF" && (ASCII(b, 3, 3) === "87a" || ASCII(b, 3, 3) === "89a")) return "image/gif";

  // WebP: a RIFF container whose form type is WEBP.
  if (ASCII(b, 0, 4) === "RIFF" && ASCII(b, 8, 4) === "WEBP") return "image/webp";

  // TIFF: byte-order mark then the magic 42.
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
    return "image/tiff";
  }

  // BMP.
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";

  // ISO base media: a `ftyp` box whose major or compatible brands say HEIC/HEIF/AVIF.
  if (ASCII(b, 4, 4) === "ftyp") {
    const boxSize = readUint32BE(b, 0);
    const end = Math.min(b.length, boxSize > 0 ? boxSize : b.length);
    const brands: string[] = [];
    for (let offset = 8; offset + 4 <= end; offset += 4) {
      if (offset === 12) continue; // minor version
      brands.push(ASCII(b, offset, 4).toLowerCase());
    }
    const major = brands[0];
    if (major && AVIF_BRANDS.has(major)) return "image/avif";
    if (major && HEIC_BRANDS.has(major)) return "image/heic";
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "image/heic";
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "image/avif";
    if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "image/heif";
  }

  return undefined;
}

/**
 * The media type of an image every bundled provider accepts — JPEG, PNG,
 * GIF or WebP — from its magic bytes, or `undefined` when the bytes are
 * something else. Use {@link detectImageType} to learn what that something
 * else was.
 */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  const type = detectImageType(bytes);
  return type !== undefined && isSupportedImageType(type) ? type : undefined;
}

/** Whether a media type is one the bundled providers accept. */
export function isSupportedImageType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
}

/** A short human name for a detected format, for messages. */
export function imageTypeName(type: DetectedImageType | undefined): string {
  switch (type) {
    case "image/jpeg": return "JPEG";
    case "image/png": return "PNG";
    case "image/gif": return "GIF";
    case "image/webp": return "WebP";
    case "image/heic": return "HEIC";
    case "image/heif": return "HEIF";
    case "image/avif": return "AVIF";
    case "image/tiff": return "TIFF";
    case "image/bmp": return "BMP";
    default: return "unknown";
  }
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

export function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
