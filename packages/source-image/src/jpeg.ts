import { readUint16BE } from "./sniff.js";

/** One marker segment of a JPEG, with its payload (the bytes after the length). */
export interface JpegSegment {
  /** The marker's second byte: `0xe1` for APP1, `0xc0` for SOF0, … */
  marker: number;
  /** Offset of the `0xff` that starts the marker. */
  offset: number;
  /** The payload, without the two length bytes. */
  data: Uint8Array;
}

/** Start-of-frame markers: everything in 0xC0–0xCF except DHT, JPG and DAC. */
export function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Walk the marker segments of a JPEG from SOI up to the start of scan.
 * Everything a header reader needs — dimensions in the SOF, EXIF in APP1 —
 * sits before the entropy-coded data, so the walk stops at SOS and never
 * touches the picture itself. Stops quietly at the first malformed
 * marker; whatever came before it is still yielded.
 */
export function* jpegSegments(bytes: Uint8Array): Generator<JpegSegment> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return;
    // Fill bytes: any number of 0xff may precede a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return;
    const marker = bytes[offset];
    offset++;
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return; // EOI or SOS: the header is over.
    if (offset + 2 > bytes.length) return;
    const length = readUint16BE(bytes, offset);
    if (length < 2) return;
    const start = offset + 2;
    const end = offset + length;
    if (end > bytes.length) {
      // Truncated segment: yield what there is, then stop.
      yield { marker, offset: offset - 1, data: bytes.subarray(start) };
      return;
    }
    yield { marker, offset: offset - 1, data: bytes.subarray(start, end) };
    offset = end;
  }
}
