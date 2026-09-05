import { imageDimensions, pngChunks, webpChunks } from "./dimensions.js";
import { jpegSegments } from "./jpeg.js";
import { detectImageType } from "./sniff.js";
import type { DetectedImageType } from "./sniff.js";

/** A position from the GPS IFD, as decimal degrees with the hemisphere applied. */
export interface GpsPosition {
  /** Degrees north; negative is south. */
  latitude: number;
  /** Degrees east; negative is west. */
  longitude: number;
  /** Metres above sea level; negative is below. Absent when the camera did not record it. */
  altitude?: number;
}

/**
 * The EXIF orientation: how the stored pixels must be transformed to be
 * viewed the right way up. 1 is "as stored"; 6 and 8 are the common
 * portrait cases from a phone held upright.
 */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * What an image's headers say about it. Every field is optional because
 * every field can be missing: a screenshot has no camera, a PNG rarely
 * has EXIF, a photo shared through a messaging app has had its GPS
 * stripped. `hasExif` says whether an EXIF block was found at all.
 */
export interface ImageMetadata {
  /** The format, from the magic bytes. */
  mediaType?: DetectedImageType;
  /** Stored width in pixels, from the format's own header. */
  width?: number;
  /** Stored height in pixels, from the format's own header. */
  height?: number;
  /** Whether an EXIF block was present, however little it held. */
  hasExif: boolean;
  /**
   * When the picture was taken: `DateTimeOriginal`, else `DateTimeDigitized`
   * (`CreateDate`), else the file's `DateTime`. EXIF stores a wall-clock time
   * with no zone; when the file also carries an `OffsetTime*` tag the instant
   * is exact, otherwise the wall clock is read as UTC — see `takenAtLocal`
   * for the digits as written.
   */
  takenAt?: Date;
  /** The capture time exactly as the camera wrote it, `YYYY-MM-DD HH:MM:SS`. */
  takenAtLocal?: string;
  /** The zone offset the camera recorded for the capture time, `±HH:MM`, when it did. */
  timeZoneOffset?: string;
  /** `DateTimeDigitized`, when it differs from the capture time. */
  digitizedAt?: Date;
  /** `DateTime` — when the file was last modified by whatever wrote it. */
  modifiedAt?: Date;
  /** Where the camera was. The best evidence a photo carries about an address. */
  gps?: GpsPosition;
  /** The EXIF orientation. Absent means 1, as stored. */
  orientation?: ExifOrientation;
  /** Camera manufacturer. */
  make?: string;
  /** Camera model. */
  model?: string;
  /** The software that wrote the file — a camera firmware, or an editor. */
  software?: string;
  /** `ImageDescription`: a caption, when a tool set one. */
  description?: string;
  /** `UserComment`: free text, when a tool set one. */
  userComment?: string;
  /** `PixelXDimension` — the width EXIF claims, when it differs from the header. */
  exifWidth?: number;
  /** `PixelYDimension` — the height EXIF claims, when it differs from the header. */
  exifHeight?: number;
}

// --- TIFF/EXIF tags -----------------------------------------------------------

const TAG = {
  ImageDescription: 0x010e,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  Software: 0x0131,
  DateTime: 0x0132,
  ExifIfd: 0x8769,
  GpsIfd: 0x8825,
  DateTimeOriginal: 0x9003,
  DateTimeDigitized: 0x9004,
  OffsetTime: 0x9010,
  OffsetTimeOriginal: 0x9011,
  OffsetTimeDigitized: 0x9012,
  SubSecTimeOriginal: 0x9291,
  UserComment: 0x9286,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
  GpsVersionId: 0x0000,
  GpsLatitudeRef: 0x0001,
  GpsLatitude: 0x0002,
  GpsLongitudeRef: 0x0003,
  GpsLongitude: 0x0004,
  GpsAltitudeRef: 0x0005,
  GpsAltitude: 0x0006,
} as const;

/** Bytes per element of each TIFF field type. Unknown types are size 0 and skipped. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** The EXIF signature at the front of a JPEG APP1 payload and some WebP EXIF chunks. */
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/** Directories with more entries than this are treated as corrupt. */
const MAX_ENTRIES = 512;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Offset of the value bytes within the TIFF block. */
  valueOffset: number;
}

class Tiff {
  private readonly view: DataView;
  constructor(readonly bytes: Uint8Array, readonly littleEndian: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16(offset: number): number { return this.view.getUint16(offset, this.littleEndian); }
  u32(offset: number): number { return this.view.getUint32(offset, this.littleEndian); }
  i32(offset: number): number { return this.view.getInt32(offset, this.littleEndian); }
  has(offset: number, length: number): boolean { return offset >= 0 && offset + length <= this.bytes.length; }

  /** The entries of the IFD at `offset`, keyed by tag. Empty for a bad offset. */
  ifd(offset: number): Map<number, Entry> {
    const entries = new Map<number, Entry>();
    if (!this.has(offset, 2)) return entries;
    const count = Math.min(this.u16(offset), MAX_ENTRIES);
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      if (!this.has(at, 12)) break;
      const tag = this.u16(at);
      const type = this.u16(at + 2);
      const n = this.u32(at + 4);
      const size = (TYPE_SIZE[type] ?? 0) * n;
      if (size === 0) continue;
      const valueOffset = size <= 4 ? at + 8 : this.u32(at + 8);
      if (!this.has(valueOffset, size)) continue;
      entries.set(tag, { tag, type, count: n, valueOffset });
    }
    return entries;
  }

  ascii(entry: Entry | undefined): string | undefined {
    if (!entry || (entry.type !== 2 && entry.type !== 7 && entry.type !== 1)) return undefined;
    const raw = this.bytes.subarray(entry.valueOffset, entry.valueOffset + entry.count);
    const end = raw.indexOf(0);
    const text = latin1(end === -1 ? raw : raw.subarray(0, end)).trim();
    return text.length > 0 ? text : undefined;
  }

  /** The first number of a SHORT/LONG/BYTE entry. */
  integer(entry: Entry | undefined): number | undefined {
    if (!entry) return undefined;
    switch (entry.type) {
      case 1: return this.bytes[entry.valueOffset];
      case 3: return this.u16(entry.valueOffset);
      case 4: return this.u32(entry.valueOffset);
      case 9: return this.i32(entry.valueOffset);
      default: return undefined;
    }
  }

  /** Every RATIONAL/SRATIONAL of an entry as a decimal. */
  rationals(entry: Entry | undefined): number[] | undefined {
    if (!entry || (entry.type !== 5 && entry.type !== 10)) return undefined;
    const values: number[] = [];
    for (let i = 0; i < entry.count; i++) {
      const at = entry.valueOffset + i * 8;
      const numerator = entry.type === 5 ? this.u32(at) : this.i32(at);
      const denominator = entry.type === 5 ? this.u32(at + 4) : this.i32(at + 4);
      values.push(denominator === 0 ? (numerator === 0 ? 0 : NaN) : numerator / denominator);
    }
    return values;
  }

  /** `UserComment`: an eight-byte character code, then the text. */
  userComment(entry: Entry | undefined): string | undefined {
    if (!entry || entry.count <= 8) return undefined;
    const raw = this.bytes.subarray(entry.valueOffset, entry.valueOffset + entry.count);
    const code = latin1(raw.subarray(0, 8)).replace(/\0+$/, "");
    const body = raw.subarray(8);
    let text: string;
    if (code === "UNICODE") {
      const units: number[] = [];
      for (let i = 0; i + 1 < body.length; i += 2) {
        units.push(this.littleEndian ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1]);
      }
      text = String.fromCharCode(...units);
    } else {
      text = latin1(body);
    }
    text = text.replace(/\0+$/g, "").replace(/\0/g, " ").trim();
    return text.length > 0 ? text : undefined;
  }
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// --- Dates --------------------------------------------------------------------

/** `YYYY:MM:DD HH:MM:SS`, as EXIF writes it. Lenient about `-` for `:` in the date, which some software uses. */
const EXIF_DATE = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/**
 * Parse an EXIF date, with an optional zone offset and sub-second string.
 * Returns the instant and the wall clock as written. Rejects the all-zero
 * placeholder cameras write when the clock was never set.
 */
export function parseExifDate(
  text: string | undefined,
  offset?: string,
  subSeconds?: string,
): { date: Date; local: string } | undefined {
  if (!text) return undefined;
  const match = EXIF_DATE.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined;
  const millis = subSeconds ? Math.round(Number(`0.${subSeconds.replace(/\D/g, "") || "0"}`) * 1000) : 0;
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const zone = offset ? OFFSET.exec(offset.trim()) : null;
  if (zone) {
    const sign = zone[1] === "-" ? -1 : 1;
    utc -= sign * (Number(zone[2]) * 60 + Number(zone[3])) * 60_000;
  }
  const date = new Date(utc);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date, local: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

function normaliseOffset(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = OFFSET.exec(text.trim());
  return match ? `${match[1]}${match[2]}:${match[3]}` : undefined;
}

// --- The parse ----------------------------------------------------------------

/**
 * Read a TIFF-structured EXIF block — the bytes after `Exif\0\0` in a JPEG
 * APP1, or a WebP `EXIF` / PNG `eXIf` chunk — into metadata. Never throws:
 * a malformed block yields whatever was readable before the damage.
 */
export function parseExifBlock(block: Uint8Array): Partial<ImageMetadata> {
  const out: Partial<ImageMetadata> = {};
  try {
    if (block.length >= 6 && EXIF_HEADER.every((b, i) => block[i] === b)) block = block.subarray(6);
    if (block.length < 8) return out;
    const order = latin1(block.subarray(0, 2));
    if (order !== "II" && order !== "MM") return out;
    const tiff = new Tiff(block, order === "II");
    if (tiff.u16(2) !== 42) return out;
    out.hasExif = true;

    const ifd0 = tiff.ifd(tiff.u32(4));
    assign(out, "description", tiff.ascii(ifd0.get(TAG.ImageDescription)));
    assign(out, "make", tiff.ascii(ifd0.get(TAG.Make)));
    assign(out, "model", tiff.ascii(ifd0.get(TAG.Model)));
    assign(out, "software", tiff.ascii(ifd0.get(TAG.Software)));
    const orientation = tiff.integer(ifd0.get(TAG.Orientation));
    if (orientation !== undefined && orientation >= 1 && orientation <= 8) out.orientation = orientation as ExifOrientation;

    const exifOffset = tiff.integer(ifd0.get(TAG.ExifIfd));
    const exif = exifOffset !== undefined ? tiff.ifd(exifOffset) : new Map<number, Entry>();

    const offsetOriginal = normaliseOffset(tiff.ascii(exif.get(TAG.OffsetTimeOriginal)));
    const offsetDigitized = normaliseOffset(tiff.ascii(exif.get(TAG.OffsetTimeDigitized)));
    const offsetModified = normaliseOffset(tiff.ascii(exif.get(TAG.OffsetTime)));

    const original = parseExifDate(
      tiff.ascii(exif.get(TAG.DateTimeOriginal)),
      offsetOriginal,
      tiff.ascii(exif.get(TAG.SubSecTimeOriginal)),
    );
    const digitized = parseExifDate(tiff.ascii(exif.get(TAG.DateTimeDigitized)), offsetDigitized ?? offsetOriginal);
    const modified = parseExifDate(tiff.ascii(ifd0.get(TAG.DateTime)), offsetModified ?? offsetOriginal);

    const taken = original ?? digitized ?? modified;
    if (taken) {
      out.takenAt = taken.date;
      out.takenAtLocal = taken.local;
      const offset = original ? offsetOriginal : digitized ? (offsetDigitized ?? offsetOriginal) : (offsetModified ?? offsetOriginal);
      if (offset) out.timeZoneOffset = offset;
    }
    if (digitized && (!original || digitized.date.getTime() !== original.date.getTime())) out.digitizedAt = digitized.date;
    if (modified) out.modifiedAt = modified.date;

    assign(out, "userComment", tiff.userComment(exif.get(TAG.UserComment)));
    const px = tiff.integer(exif.get(TAG.PixelXDimension));
    const py = tiff.integer(exif.get(TAG.PixelYDimension));
    if (px !== undefined && px > 0) out.exifWidth = px;
    if (py !== undefined && py > 0) out.exifHeight = py;

    const gpsOffset = tiff.integer(ifd0.get(TAG.GpsIfd));
    if (gpsOffset !== undefined) {
      const gps = tiff.ifd(gpsOffset);
      const latitude = toDegrees(tiff.rationals(gps.get(TAG.GpsLatitude)), tiff.ascii(gps.get(TAG.GpsLatitudeRef)), "S");
      const longitude = toDegrees(tiff.rationals(gps.get(TAG.GpsLongitude)), tiff.ascii(gps.get(TAG.GpsLongitudeRef)), "W");
      if (latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
        const position: GpsPosition = { latitude, longitude };
        const altitude = tiff.rationals(gps.get(TAG.GpsAltitude))?.[0];
        if (altitude !== undefined && Number.isFinite(altitude)) {
          const below = tiff.integer(gps.get(TAG.GpsAltitudeRef)) === 1;
          position.altitude = below ? -altitude : altitude;
        }
        out.gps = position;
      }
    }
  } catch {
    // A truncated or hostile block: keep what was read.
  }
  return out;
}

function assign<K extends keyof ImageMetadata>(out: Partial<ImageMetadata>, key: K, value: ImageMetadata[K] | undefined): void {
  if (value !== undefined) out[key] = value;
}

/** Degrees, minutes, seconds (any of which may carry the fraction) to signed decimal degrees. */
function toDegrees(dms: number[] | undefined, ref: string | undefined, negativeRef: "S" | "W"): number | undefined {
  if (!dms || dms.length === 0 || dms.some((n) => !Number.isFinite(n))) return undefined;
  const [d = 0, m = 0, s = 0] = dms;
  const value = d + m / 60 + s / 3600;
  if (!Number.isFinite(value)) return undefined;
  const negative = ref?.trim().toUpperCase().startsWith(negativeRef) ?? false;
  return negative ? -value : value;
}

/** The raw EXIF block of an image, if it carries one. Format-specific container walking. */
export function findExifBlock(bytes: Uint8Array): Uint8Array | undefined {
  switch (detectImageType(bytes)) {
    case "image/jpeg":
      for (const segment of jpegSegments(bytes)) {
        if (segment.marker === 0xe1 && EXIF_HEADER.every((b, i) => segment.data[i] === b)) return segment.data;
      }
      return undefined;
    case "image/webp":
      for (const chunk of webpChunks(bytes)) if (chunk.fourcc === "EXIF") return chunk.data;
      return undefined;
    case "image/png":
      for (const chunk of pngChunks(bytes)) if (chunk.type === "eXIf") return chunk.data;
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Everything the headers of an image say about it: the format and stored
 * size from the container, and the EXIF — capture date, GPS position,
 * orientation, camera, software, caption — when there is one. JPEG APP1,
 * WebP `EXIF` chunks and PNG `eXIf` chunks are read, in either byte order.
 *
 * Never throws. An image that is not one of the formats this package reads,
 * or whose EXIF is damaged, comes back with the fields that were readable
 * and nothing else.
 */
export function extractExif(bytes: Uint8Array): ImageMetadata {
  const out: ImageMetadata = { hasExif: false };
  try {
    const mediaType = detectImageType(bytes);
    if (mediaType) out.mediaType = mediaType;
    const dims = imageDimensions(bytes);
    if (dims) {
      out.width = dims.width;
      out.height = dims.height;
    }
    const block = findExifBlock(bytes);
    if (block) Object.assign(out, parseExifBlock(block));
    // EXIF's own pixel dimensions are only worth reporting when they disagree with the header.
    if (out.exifWidth === out.width) delete out.exifWidth;
    if (out.exifHeight === out.height) delete out.exifHeight;
  } catch {
    // Keep whatever was read.
  }
  return out;
}

/** What each EXIF orientation means, in words. */
export function describeOrientation(orientation: ExifOrientation): string {
  switch (orientation) {
    case 1: return "as stored";
    case 2: return "mirrored horizontally";
    case 3: return "rotated 180°";
    case 4: return "mirrored vertically";
    case 5: return "mirrored horizontally and rotated 90° counter-clockwise";
    case 6: return "rotated 90° clockwise to display (stored on its side)";
    case 7: return "mirrored horizontally and rotated 90° clockwise";
    case 8: return "rotated 90° counter-clockwise to display (stored on its side)";
  }
}

export { TAG as EXIF_TAG };
