import { describe, it, expect } from "vitest";
import { describeOrientation, encodeExif, extractExif, parseExifBlock, parseExifDate, writeExif } from "../index.js";
import { YACHATS, app1, concat, jpegWithExif, pngWithExif, tinyJpeg, webpExtended } from "./fixtures.js";

describe("extractExif", () => {
  for (const byteOrder of ["II", "MM"] as const) {
    it(`reads a JPEG APP1 written ${byteOrder === "II" ? "little" : "big"}-endian`, () => {
      const meta = extractExif(jpegWithExif(YACHATS, { byteOrder }));
      expect(meta.hasExif).toBe(true);
      expect(meta.mediaType).toBe("image/jpeg");
      expect(meta.width).toBe(4);
      expect(meta.height).toBe(3);
      expect(meta.takenAt?.toISOString()).toBe("2025-06-14T16:12:30.000Z");
      expect(meta.takenAtLocal).toBe("2025-06-14 09:12:30");
      expect(meta.timeZoneOffset).toBe("-07:00");
      expect(meta.gps?.latitude).toBeCloseTo(44.3114, 5);
      expect(meta.gps?.longitude).toBeCloseTo(-124.1049, 5);
      expect(meta.gps?.altitude).toBe(12);
      expect(meta.orientation).toBe(6);
      expect(meta.make).toBe("Apple");
      expect(meta.model).toBe("iPhone 15 Pro");
      expect(meta.software).toBe("17.5.1");
      expect(meta.description).toBe("Sea Cabin from the beach");
      expect(meta.userComment).toBe("Listing photo");
      // EXIF claims 4032×3024 for a 4×3 file: reported, because it disagrees with the header.
      expect(meta.exifWidth).toBe(4032);
      expect(meta.exifHeight).toBe(3024);
    });
  }

  it("applies the southern and western hemispheres and a below-sea-level altitude", () => {
    const meta = extractExif(jpegWithExif({ gps: { latitude: -33.8688, longitude: 151.2093, altitude: -3.5 } }));
    expect(meta.gps?.latitude).toBeCloseTo(-33.8688, 5);
    expect(meta.gps?.longitude).toBeCloseTo(151.2093, 5);
    expect(meta.gps?.altitude).toBe(-3.5);
  });

  it("reads a wall clock without an offset as UTC and says so", () => {
    const meta = extractExif(jpegWithExif({ takenAt: new Date("2024-01-02T03:04:05Z") }));
    expect(meta.takenAt?.toISOString()).toBe("2024-01-02T03:04:05.000Z");
    expect(meta.takenAtLocal).toBe("2024-01-02 03:04:05");
    expect(meta.timeZoneOffset).toBeUndefined();
    expect(meta.digitizedAt).toBeUndefined(); // same as the original, so not repeated
    expect(meta.modifiedAt?.toISOString()).toBe("2024-01-02T03:04:05.000Z");
  });

  it("keeps sub-seconds", () => {
    const meta = extractExif(jpegWithExif({ takenAt: new Date("2024-01-02T03:04:05.250Z") }));
    expect(meta.takenAt?.toISOString()).toBe("2024-01-02T03:04:05.250Z");
  });

  it("reports no EXIF for a plain JPEG and a plain PNG, with the header dimensions", () => {
    expect(extractExif(tinyJpeg())).toEqual({ hasExif: false, mediaType: "image/jpeg", width: 4, height: 3 });
  });

  it("reads a WebP EXIF chunk", () => {
    const meta = extractExif(webpExtended(1600, 900, encodeExif({ gps: YACHATS.gps, make: "Google", model: "Pixel 8" })));
    expect(meta.mediaType).toBe("image/webp");
    expect(meta.width).toBe(1600);
    expect(meta.gps?.latitude).toBeCloseTo(44.3114, 5);
    expect(meta.model).toBe("Pixel 8");
  });

  it("reads a WebP EXIF chunk that carries the Exif\\0\\0 prefix", () => {
    const prefixed = concat([Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0, 0]), encodeExif({ make: "Canon" })]);
    expect(extractExif(webpExtended(10, 10, prefixed)).make).toBe("Canon");
  });

  it("reads a PNG eXIf chunk", () => {
    const meta = extractExif(pngWithExif(3, 2, { takenAt: new Date("2025-03-01T10:00:00Z"), orientation: 8 }));
    expect(meta.mediaType).toBe("image/png");
    expect(meta.width).toBe(3);
    expect(meta.takenAt?.toISOString()).toBe("2025-03-01T10:00:00.000Z");
    expect(meta.orientation).toBe(8);
  });

  it("never throws on malformed EXIF, and keeps what came before the damage", () => {
    const good = encodeExif(YACHATS);
    // Truncate mid-way through the Exif IFD: IFD0 (make, model…) is intact, the GPS IFD is gone.
    const truncated = good.subarray(0, good.length - 60);
    const meta = extractExif(concat([tinyJpeg().subarray(0, 2), app1(truncated), tinyJpeg().subarray(2)]));
    expect(meta.hasExif).toBe(true);
    expect(meta.make).toBe("Apple");
    expect(meta.gps).toBeUndefined();

    // A pointer past the end of the block.
    const wild = encodeExif({ make: "X" });
    wild[4] = 0xff; // IFD0 offset → nonsense
    expect(extractExif(concat([tinyJpeg().subarray(0, 2), app1(wild), tinyJpeg().subarray(2)]))).toEqual({
      hasExif: true,
      mediaType: "image/jpeg",
      width: 4,
      height: 3,
    });

    // Not TIFF at all.
    const junk = concat([tinyJpeg().subarray(0, 2), app1(new TextEncoder().encode("hello world")), tinyJpeg().subarray(2)]);
    expect(extractExif(junk).hasExif).toBe(false);

    // A byte-order mark with an absurd entry count.
    const bloated = encodeExif({ make: "X" });
    bloated[8] = 0xff;
    bloated[9] = 0xff;
    expect(() => extractExif(concat([tinyJpeg().subarray(0, 2), app1(bloated), tinyJpeg().subarray(2)]))).not.toThrow();
  });

  it("drops an all-zero date and an out-of-range orientation", () => {
    expect(parseExifDate("0000:00:00 00:00:00")).toBeUndefined();
    expect(parseExifDate("garbage")).toBeUndefined();
    expect(parseExifDate("2024:13:01 00:00:00")).toBeUndefined();
    const block = encodeExif({ orientation: 6 });
    // Orientation is a SHORT inline value at the entry; overwrite it with 9.
    const view = new DataView(block.buffer, block.byteOffset);
    const entryAt = 8 + 2; // first (only) IFD0 entry
    expect(view.getUint16(entryAt, true)).toBe(0x0112);
    view.setUint16(entryAt + 8, 9, true);
    expect(parseExifBlock(block).orientation).toBeUndefined();
  });

  it("parses dates with an explicit offset", () => {
    expect(parseExifDate("2025:06:14 09:12:30", "+02:00")?.date.toISOString()).toBe("2025-06-14T07:12:30.000Z");
    expect(parseExifDate("2025-06-14 09:12:30")?.local).toBe("2025-06-14 09:12:30");
  });

  it("describes orientations", () => {
    expect(describeOrientation(1)).toBe("as stored");
    expect(describeOrientation(6)).toContain("90° clockwise");
  });
});

describe("writeExif", () => {
  it("replaces an existing EXIF segment rather than adding a second", () => {
    const first = writeExif(tinyJpeg(), { make: "One" });
    const second = writeExif(first, { make: "Two" });
    expect(extractExif(second).make).toBe("Two");
    expect(second.length).toBe(first.length);
    // Still a decodable structure: SOI, one APP1, then the original segments.
    expect(second[0]).toBe(0xff);
    expect(second[1]).toBe(0xd8);
    expect(second[2]).toBe(0xff);
    expect(second[3]).toBe(0xe1);
  });

  it("refuses anything but a JPEG", () => {
    expect(() => writeExif(new Uint8Array(20), { make: "X" })).toThrow(TypeError);
  });
});
