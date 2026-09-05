import { isSofMarker, jpegSegments } from "./jpeg.js";
import { detectImageType, readUint16BE, readUint16LE, readUint24LE, readUint32BE, readUint32LE } from "./sniff.js";

/** Pixel size of an image, as its header declares it. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * The pixel size of a JPEG, PNG, GIF or WebP from its header alone. Nothing
 * is decoded. `undefined` for any other format, or when the header is too
 * damaged to say.
 *
 * The size is the stored one: a JPEG whose EXIF orientation says "rotate
 * 90°" reports the sensor's width and height, not the displayed ones.
 * {@link extractExif} reports the orientation beside them.
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  switch (detectImageType(bytes)) {
    case "image/jpeg": return jpegDimensions(bytes);
    case "image/png": return pngDimensions(bytes);
    case "image/gif": return gifDimensions(bytes);
    case "image/webp": return webpDimensions(bytes);
    default: return undefined;
  }
}

function valid(width: number, height: number): ImageDimensions | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  for (const segment of jpegSegments(bytes)) {
    // SOF payload: precision (1), height (2), width (2), components…
    if (isSofMarker(segment.marker) && segment.data.length >= 5) {
      return valid(readUint16BE(segment.data, 3), readUint16BE(segment.data, 1));
    }
  }
  return undefined;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // Signature (8), IHDR length (4), "IHDR" (4), width (4), height (4).
  if (bytes.length < 24) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  return valid(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // Logical screen descriptor follows the six-byte header.
  if (bytes.length < 10) return undefined;
  return valid(readUint16LE(bytes, 6), readUint16LE(bytes, 8));
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  const payload = 20;
  switch (chunk) {
    case "VP8 ": {
      // Frame tag (3), start code 9d 01 2a (3), width (2, 14 bits), height (2, 14 bits).
      if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) return undefined;
      return valid(readUint16LE(bytes, payload + 6) & 0x3fff, readUint16LE(bytes, payload + 8) & 0x3fff);
    }
    case "VP8L": {
      // Signature 0x2f, then 14 bits width-1, 14 bits height-1.
      if (bytes[payload] !== 0x2f) return undefined;
      const b1 = bytes[payload + 1];
      const b2 = bytes[payload + 2];
      const b3 = bytes[payload + 3];
      const b4 = bytes[payload + 4];
      const width = (b1 | ((b2 & 0x3f) << 8)) + 1;
      const height = ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) + 1;
      return valid(width, height);
    }
    case "VP8X": {
      // Flags (1), reserved (3), canvas width-1 (3), canvas height-1 (3).
      return valid(readUint24LE(bytes, payload + 4) + 1, readUint24LE(bytes, payload + 7) + 1);
    }
    default:
      return undefined;
  }
}

/**
 * Walk the chunks of a RIFF/WebP container. Used for the EXIF chunk; the
 * dimensions come from the first chunk alone.
 */
export function* webpChunks(bytes: Uint8Array): Generator<{ fourcc: string; data: Uint8Array }> {
  if (detectImageType(bytes) !== "image/webp") return;
  const riffEnd = Math.min(bytes.length, 8 + readUint32LE(bytes, 4));
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const fourcc = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = readUint32LE(bytes, offset + 4);
    const start = offset + 8;
    const end = Math.min(riffEnd, start + size);
    yield { fourcc, data: bytes.subarray(start, end) };
    offset = start + size + (size % 2); // chunks are padded to even sizes
  }
}

/** Walk the chunks of a PNG. Used for the `eXIf` chunk. */
export function* pngChunks(bytes: Uint8Array): Generator<{ type: string; data: Uint8Array }> {
  if (detectImageType(bytes) !== "image/png") return;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) return;
    yield { type, data: bytes.subarray(start, end) };
    if (type === "IEND") return;
    offset = end + 4; // skip the CRC
  }
}
