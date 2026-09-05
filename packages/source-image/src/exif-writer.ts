import { EXIF_TAG as TAG } from "./exif.js";
import type { ExifOrientation, GpsPosition } from "./exif.js";
import { jpegSegments } from "./jpeg.js";
import { detectImageType } from "./sniff.js";

/**
 * The metadata {@link writeExif} can stamp onto a JPEG. A deliberately
 * small subset: enough to build a fixture or a test — a photo with a
 * capture date and a GPS position — not a general EXIF editor.
 */
export interface WritableImageMetadata {
  /** The capture time. Written as the wall clock in `timeZoneOffset`, or UTC without one. */
  takenAt?: Date;
  /** `±HH:MM`. When given, `OffsetTimeOriginal` is written so the instant round-trips exactly. */
  timeZoneOffset?: string;
  gps?: GpsPosition;
  orientation?: ExifOrientation;
  make?: string;
  model?: string;
  software?: string;
  description?: string;
  userComment?: string;
  /** `PixelXDimension` / `PixelYDimension`. */
  width?: number;
  height?: number;
}

/** Options for {@link encodeExif} and {@link writeExif}. */
export interface EncodeExifOptions {
  /** TIFF byte order: `"II"` little-endian (the default, what most cameras write) or `"MM"` big-endian. */
  byteOrder?: "II" | "MM";
}

type FieldType = 1 | 2 | 3 | 4 | 5 | 7;
const SIZE: Record<FieldType, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

interface Field {
  tag: number;
  type: FieldType;
  count: number;
  /** The value bytes, already in the chosen byte order. */
  data: Uint8Array;
}

class Writer {
  constructor(readonly littleEndian: boolean) {}

  u16(value: number): Uint8Array {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value, this.littleEndian);
    return b;
  }
  u32(value: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, this.littleEndian);
    return b;
  }
  ascii(tag: number, text: string): Field {
    const bytes = new Uint8Array(text.length + 1);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return { tag, type: 2, count: bytes.length, data: bytes };
  }
  short(tag: number, value: number): Field {
    return { tag, type: 3, count: 1, data: this.u16(value) };
  }
  long(tag: number, value: number): Field {
    return { tag, type: 4, count: 1, data: this.u32(value) };
  }
  byte(tag: number, values: number[]): Field {
    return { tag, type: 1, count: values.length, data: Uint8Array.from(values) };
  }
  undefined(tag: number, bytes: Uint8Array): Field {
    return { tag, type: 7, count: bytes.length, data: bytes };
  }
  rationals(tag: number, values: Array<[number, number]>): Field {
    const data = new Uint8Array(values.length * 8);
    values.forEach(([n, d], i) => {
      data.set(this.u32(n), i * 8);
      data.set(this.u32(d), i * 8 + 4);
    });
    return { tag, type: 5, count: values.length, data };
  }

  /** Size of an IFD with these fields, including its out-of-line values (each padded to even). */
  ifdSize(fields: Field[]): number {
    let size = 2 + fields.length * 12 + 4;
    for (const f of fields) if (f.data.length > 4) size += f.data.length + (f.data.length % 2);
    return size;
  }

  /** Emit an IFD at `offset` (relative to the TIFF start), with its values placed after the entry table. */
  ifd(fields: Field[], offset: number): Uint8Array {
    const sorted = [...fields].sort((a, b) => a.tag - b.tag);
    const out = new Uint8Array(this.ifdSize(sorted));
    out.set(this.u16(sorted.length), 0);
    let dataAt = 2 + sorted.length * 12 + 4;
    sorted.forEach((f, i) => {
      const at = 2 + i * 12;
      out.set(this.u16(f.tag), at);
      out.set(this.u16(f.type), at + 2);
      out.set(this.u32(f.count), at + 4);
      if (f.data.length <= 4) {
        out.set(f.data, at + 8);
      } else {
        out.set(this.u32(offset + dataAt), at + 8);
        out.set(f.data, dataAt);
        dataAt += f.data.length + (f.data.length % 2);
      }
    });
    // Next-IFD pointer: none.
    out.set(this.u32(0), 2 + sorted.length * 12);
    return out;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** An instant as the EXIF wall clock in a zone. */
function exifDate(date: Date, offset: string | undefined): string {
  let shifted = date.getTime();
  const match = offset ? /^([+-])(\d{2}):(\d{2})$/.exec(offset) : null;
  if (match) shifted += (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
  const d = new Date(shifted);
  return `${d.getUTCFullYear()}:${pad(d.getUTCMonth() + 1)}:${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Decimal degrees to three rationals: whole degrees, whole minutes, seconds to four decimals. */
function toDms(value: number): Array<[number, number]> {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFull = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = Math.round((minutesFull - minutes) * 60 * 10_000);
  return [[degrees, 1], [minutes, 1], [seconds, 10_000]];
}

/**
 * Encode metadata as a TIFF-structured EXIF block: what goes after
 * `Exif\0\0` in a JPEG APP1 segment, or straight into a WebP `EXIF` or PNG
 * `eXIf` chunk. Both byte orders are supported so a reader can be tested
 * against each.
 */
export function encodeExif(metadata: WritableImageMetadata, options: EncodeExifOptions = {}): Uint8Array {
  const littleEndian = (options.byteOrder ?? "II") === "II";
  const w = new Writer(littleEndian);

  const ifd0: Field[] = [];
  const exif: Field[] = [];
  const gps: Field[] = [];

  if (metadata.description) ifd0.push(w.ascii(TAG.ImageDescription, metadata.description));
  if (metadata.make) ifd0.push(w.ascii(TAG.Make, metadata.make));
  if (metadata.model) ifd0.push(w.ascii(TAG.Model, metadata.model));
  if (metadata.orientation) ifd0.push(w.short(TAG.Orientation, metadata.orientation));
  if (metadata.software) ifd0.push(w.ascii(TAG.Software, metadata.software));

  if (metadata.takenAt) {
    const wallClock = exifDate(metadata.takenAt, metadata.timeZoneOffset);
    ifd0.push(w.ascii(TAG.DateTime, wallClock));
    exif.push(w.ascii(TAG.DateTimeOriginal, wallClock));
    exif.push(w.ascii(TAG.DateTimeDigitized, wallClock));
    if (metadata.timeZoneOffset) {
      exif.push(w.ascii(TAG.OffsetTimeOriginal, metadata.timeZoneOffset));
      exif.push(w.ascii(TAG.OffsetTimeDigitized, metadata.timeZoneOffset));
    }
    const millis = metadata.takenAt.getUTCMilliseconds();
    if (millis > 0) exif.push(w.ascii(TAG.SubSecTimeOriginal, String(millis).padStart(3, "0")));
  }
  if (metadata.userComment) {
    const text = metadata.userComment;
    const bytes = new Uint8Array(8 + text.length);
    bytes.set([0x41, 0x53, 0x43, 0x49, 0x49, 0, 0, 0]); // "ASCII\0\0\0"
    for (let i = 0; i < text.length; i++) bytes[8 + i] = text.charCodeAt(i) & 0xff;
    exif.push(w.undefined(TAG.UserComment, bytes));
  }
  if (metadata.width) exif.push(w.long(TAG.PixelXDimension, metadata.width));
  if (metadata.height) exif.push(w.long(TAG.PixelYDimension, metadata.height));

  if (metadata.gps) {
    const { latitude, longitude, altitude } = metadata.gps;
    gps.push(w.byte(TAG.GpsVersionId, [2, 3, 0, 0]));
    gps.push(w.ascii(TAG.GpsLatitudeRef, latitude < 0 ? "S" : "N"));
    gps.push(w.rationals(TAG.GpsLatitude, toDms(latitude)));
    gps.push(w.ascii(TAG.GpsLongitudeRef, longitude < 0 ? "W" : "E"));
    gps.push(w.rationals(TAG.GpsLongitude, toDms(longitude)));
    if (altitude !== undefined) {
      gps.push(w.byte(TAG.GpsAltitudeRef, [altitude < 0 ? 1 : 0]));
      gps.push(w.rationals(TAG.GpsAltitude, [[Math.round(Math.abs(altitude) * 100), 100]]));
    }
  }

  // Layout: header (8) · IFD0 · Exif IFD · GPS IFD. Pointer fields are LONGs
  // whose size is known, so the offsets can be computed before emitting.
  const exifOffset = 8 + w.ifdSize(ifd0) + (exif.length > 0 ? 12 : 0) + (gps.length > 0 ? 12 : 0);
  if (exif.length > 0) ifd0.push(w.long(TAG.ExifIfd, exifOffset));
  const gpsOffset = exifOffset + (exif.length > 0 ? w.ifdSize(exif) : 0);
  if (gps.length > 0) ifd0.push(w.long(TAG.GpsIfd, gpsOffset));

  const parts: Uint8Array[] = [
    Uint8Array.from(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    w.u16(42),
    w.u32(8),
    w.ifd(ifd0, 8),
  ];
  if (exif.length > 0) parts.push(w.ifd(exif, exifOffset));
  if (gps.length > 0) parts.push(w.ifd(gps, gpsOffset));
  return concat(parts);
}

/** The full APP1 segment for a JPEG: marker, length, `Exif\0\0`, then the block. */
export function exifApp1Segment(block: Uint8Array): Uint8Array {
  const length = 2 + 6 + block.length;
  if (length > 0xffff) throw new RangeError("EXIF block too large for one APP1 segment");
  return concat([Uint8Array.from([0xff, 0xe1, length >> 8, length & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]), block]);
}

/**
 * A copy of a JPEG with the given metadata as its EXIF, replacing any EXIF
 * it had. The APP1 segment goes straight after SOI, ahead of any JFIF APP0,
 * which every reader accepts. Throws a `TypeError` for anything but a JPEG:
 * WebP and PNG carry EXIF in chunks this small writer does not build.
 */
export function writeExif(jpeg: Uint8Array, metadata: WritableImageMetadata, options: EncodeExifOptions = {}): Uint8Array {
  if (detectImageType(jpeg) !== "image/jpeg") throw new TypeError("writeExif needs a JPEG");
  const segment = exifApp1Segment(encodeExif(metadata, options));
  // Drop existing EXIF APP1 segments; keep everything else in order.
  const drop: Array<[number, number]> = [];
  for (const s of jpegSegments(jpeg)) {
    const isExif = s.marker === 0xe1 && s.data[0] === 0x45 && s.data[1] === 0x78 && s.data[2] === 0x69 && s.data[3] === 0x66;
    if (isExif) drop.push([s.offset, s.offset + 4 + s.data.length]);
  }
  const parts: Uint8Array[] = [jpeg.subarray(0, 2), segment];
  let cursor = 2;
  for (const [start, end] of drop) {
    parts.push(jpeg.subarray(cursor, start));
    cursor = end;
  }
  parts.push(jpeg.subarray(cursor));
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
