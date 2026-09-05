/**
 * Image fixtures built in code, so the tests own their bytes: a real
 * baseline JPEG, a self-encoded PNG, and hand-written headers for the
 * formats where only the header matters.
 */
import { deflateSync } from "node:zlib";
import { encodeExif } from "../exif-writer.js";
import type { EncodeExifOptions, WritableImageMetadata } from "../exif-writer.js";

/** A 4×3 baseline JPEG, 270 bytes, as sharp encodes a solid red rectangle. */
export const TINY_JPEG_BASE64 =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z";

export function tinyJpeg(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_JPEG_BASE64, "base64"));
}

/** A JPEG with the given EXIF stamped on it, via the package's own writer. */
export function jpegWithExif(metadata: WritableImageMetadata, options?: EncodeExifOptions): Uint8Array {
  return concat([
    tinyJpeg().subarray(0, 2),
    app1(encodeExif(metadata, options)),
    tinyJpeg().subarray(2),
  ]);
}

/** An APP1 segment around a TIFF block: marker, length, `Exif\0\0`, block. */
export function app1(block: Uint8Array): Uint8Array {
  const length = 2 + 6 + block.length;
  return concat([Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]), block]);
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const typed = concat([Uint8Array.from(type, (c) => c.charCodeAt(0)), data]);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(typed));
  return concat([length, typed, crc]);
}

/** A solid-colour RGB PNG of the given size, with optional extra chunks after IHDR. */
export function png(width: number, height: number, extraChunks: Uint8Array[] = []): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) raw.set([200, 120, 40], y * (width * 3 + 1) + 1 + x * 3);
  }
  return concat([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    ...extraChunks,
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** A PNG carrying an `eXIf` chunk. */
export function pngWithExif(width: number, height: number, metadata: WritableImageMetadata, options?: EncodeExifOptions): Uint8Array {
  return png(width, height, [pngChunk("eXIf", encodeExif(metadata, options))]);
}

// --- GIF ---------------------------------------------------------------------

/** A GIF89a header with a logical screen of the given size, and nothing after it. */
export function gifHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(16);
  out.set(Uint8Array.from("GIF89a", (c) => c.charCodeAt(0)));
  out[6] = width & 0xff;
  out[7] = width >> 8;
  out[8] = height & 0xff;
  out[9] = height >> 8;
  out[13] = 0x3b; // trailer, for good measure
  return out;
}

// --- WebP --------------------------------------------------------------------

function riff(chunks: Array<{ fourcc: string; data: Uint8Array }>): Uint8Array {
  const body = concat(
    chunks.flatMap(({ fourcc, data }) => {
      const size = new Uint8Array(4);
      new DataView(size.buffer).setUint32(0, data.length, true);
      const pad = data.length % 2 === 1 ? [new Uint8Array(1)] : [];
      return [Uint8Array.from(fourcc, (c) => c.charCodeAt(0)), size, data, ...pad];
    }),
  );
  const riffSize = new Uint8Array(4);
  new DataView(riffSize.buffer).setUint32(0, 4 + body.length, true);
  return concat([Uint8Array.from("RIFF", (c) => c.charCodeAt(0)), riffSize, Uint8Array.from("WEBP", (c) => c.charCodeAt(0)), body]);
}

/** A lossy (`VP8 `) WebP header: frame tag, start code, 14-bit dimensions. No real frame data. */
export function webpLossy(width: number, height: number): Uint8Array {
  const data = new Uint8Array(16);
  data.set([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a], 0);
  new DataView(data.buffer).setUint16(6, width & 0x3fff, true);
  new DataView(data.buffer).setUint16(8, height & 0x3fff, true);
  return riff([{ fourcc: "VP8 ", data }]);
}

/** A lossless (`VP8L`) WebP header with its packed 14-bit dimensions. */
export function webpLossless(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  const data = new Uint8Array(12);
  data[0] = 0x2f;
  data[1] = w & 0xff;
  data[2] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
  data[3] = (h >> 2) & 0xff;
  data[4] = (h >> 10) & 0x0f;
  return riff([{ fourcc: "VP8L", data }]);
}

/** An extended (`VP8X`) WebP with a canvas size and, optionally, an EXIF chunk. */
export function webpExtended(width: number, height: number, exif?: Uint8Array): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = exif ? 0x08 : 0x00; // EXIF flag
  const w = width - 1;
  const h = height - 1;
  data.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 4);
  data.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 7);
  const chunks: Array<{ fourcc: string; data: Uint8Array }> = [{ fourcc: "VP8X", data }, { fourcc: "VP8 ", data: new Uint8Array(10) }];
  if (exif) chunks.push({ fourcc: "EXIF", data: exif });
  return riff(chunks);
}

// --- Others ------------------------------------------------------------------

/** The start of a HEIC from an iPhone: a `ftyp` box with major brand `heic`. */
export function heicHeader(major = "heic", compatible: string[] = ["mif1", "heic"]): Uint8Array {
  const size = 16 + compatible.length * 4;
  const out = new Uint8Array(Math.max(size, 32));
  new DataView(out.buffer).setUint32(0, size);
  out.set(Uint8Array.from("ftyp", (c) => c.charCodeAt(0)), 4);
  out.set(Uint8Array.from(major, (c) => c.charCodeAt(0)), 8);
  compatible.forEach((brand, i) => out.set(Uint8Array.from(brand, (c) => c.charCodeAt(0)), 16 + i * 4));
  return out;
}

/** A little-endian TIFF header with an empty IFD. */
export function tiffHeader(): Uint8Array {
  return Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The metadata most tests stamp: a summer morning on the Oregon coast. */
export const YACHATS: WritableImageMetadata = {
  takenAt: new Date("2025-06-14T16:12:30Z"),
  timeZoneOffset: "-07:00",
  gps: { latitude: 44.3114, longitude: -124.1049, altitude: 12 },
  orientation: 6,
  make: "Apple",
  model: "iPhone 15 Pro",
  software: "17.5.1",
  description: "Sea Cabin from the beach",
  userComment: "Listing photo",
  width: 4032,
  height: 3024,
};
