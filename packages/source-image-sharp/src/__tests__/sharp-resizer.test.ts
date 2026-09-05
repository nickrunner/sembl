import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { ImageSourceError, extractExif, imageDimensions, prepareImages, sniffImageType, writeExif } from "@sembl/source-image";
import { DEFAULT_MAX_EDGE, SharpResizer, defaultFormat, sharpSupportsHeif } from "../index.js";

async function testPng(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
  return new Uint8Array(buffer);
}

async function testJpeg(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } } }).jpeg().toBuffer();
  return new Uint8Array(buffer);
}

/** A `ftyp` box with major brand `heic`: enough for the sniff, never decodable. */
function fakeHeic(): Uint8Array {
  const out = new Uint8Array(64);
  out[3] = 24;
  out.set(Uint8Array.from("ftypheic", (c) => c.charCodeAt(0)), 4);
  out.set(Uint8Array.from("mif1heic", (c) => c.charCodeAt(0)), 16);
  return out;
}

describe("SharpResizer", () => {
  it("downscales to the default long edge and keeps PNG as PNG", async () => {
    const out = await new SharpResizer().resize({ data: await testPng(3000, 2000), mediaType: "image/png" });
    expect(out.mediaType).toBe("image/png");
    expect(out.width).toBe(DEFAULT_MAX_EDGE);
    expect(out.height).toBe(Math.round((2000 * DEFAULT_MAX_EDGE) / 3000));
    expect(sniffImageType(out.data)).toBe("image/png");
    expect(imageDimensions(out.data)).toEqual({ width: out.width, height: out.height });
  });

  it("never enlarges", async () => {
    const out = await new SharpResizer().resize({ data: await testPng(40, 30), mediaType: "image/png" });
    expect([out.width, out.height]).toEqual([40, 30]);
  });

  it("converts to JPEG and WebP at the asked quality, with constructor defaults overridable per call", async () => {
    const resizer = new SharpResizer({ maxEdge: 100, format: "image/jpeg", quality: 50 });
    const jpeg = await resizer.resize({ data: await testPng(400, 200), mediaType: "image/png" });
    expect(jpeg.mediaType).toBe("image/jpeg");
    expect(sniffImageType(jpeg.data)).toBe("image/jpeg");
    expect([jpeg.width, jpeg.height]).toEqual([100, 50]);
    const webp = await resizer.resize({ data: await testPng(400, 200), mediaType: "image/png" }, { format: "image/webp", maxEdge: 50 });
    expect(webp.mediaType).toBe("image/webp");
    expect(sniffImageType(webp.data)).toBe("image/webp");
    expect([webp.width, webp.height]).toEqual([50, 25]);
  });

  it("auto-orients from EXIF and strips the metadata", async () => {
    const sideways = writeExif(await testJpeg(300, 100), {
      orientation: 6,
      gps: { latitude: 44.3114, longitude: -124.1049 },
      make: "Apple",
    });
    expect(extractExif(sideways).orientation).toBe(6);
    const out = await new SharpResizer().resize({ data: sideways, mediaType: "image/jpeg" });
    expect([out.width, out.height]).toEqual([100, 300]);
    const meta = extractExif(out.data);
    expect(meta.hasExif).toBe(false);
    expect(meta.gps).toBeUndefined();
    expect(meta.width).toBe(100);
  });

  it("can keep the metadata and leave the pixels as stored", async () => {
    const sideways = writeExif(await testJpeg(300, 100), { orientation: 6, make: "Apple" });
    const out = await new SharpResizer().resize({ data: sideways, mediaType: "image/jpeg" }, { stripMetadata: false, autoOrient: false });
    expect([out.width, out.height]).toEqual([300, 100]);
    const meta = extractExif(out.data);
    expect(meta.make).toBe("Apple");
    expect(meta.orientation).toBe(6);
  });

  it("refuses HEIC as unsupported with a message that names the cause", async () => {
    const error = await new SharpResizer().resize({ data: fakeHeic(), mediaType: "image/heic" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageSourceError);
    expect((error as ImageSourceError).kind).toBe("unsupported");
    expect((error as ImageSourceError).message).toContain("HEIC");
    expect((error as ImageSourceError).message).toMatch(/HEVC|HEIF/);
    expect(typeof sharpSupportsHeif()).toBe("boolean");
  });

  it("refuses bytes that are not an image", async () => {
    const error = await new SharpResizer().resize({ data: new TextEncoder().encode("<html>"), mediaType: "image/jpeg" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageSourceError);
    expect((error as ImageSourceError).kind).toBe("unsupported");
  });

  it("works through prepareImages, with the EXIF read before it is stripped", async () => {
    const photo = writeExif(await testJpeg(2000, 1500), { gps: { latitude: 44.3114, longitude: -124.1049 }, takenAt: new Date("2025-06-14T16:12:30Z") });
    const out = await prepareImages([{ label: "Photo", image: { data: photo, mediaType: "image/jpeg" } }], new SharpResizer(), { maxEdge: 800 });
    expect(out).toHaveLength(2);
    const image = out[0];
    expect("image" in image && "data" in image.image && imageDimensions(image.image.data as Uint8Array)).toEqual({ width: 800, height: 600 });
    expect("image" in image && "data" in image.image && extractExif(image.image.data as Uint8Array).hasExif).toBe(false);
    expect((out[1] as { text: string }).text).toContain("44.311400, -124.104900");
  });

  it("picks an output format from the input", () => {
    expect(defaultFormat("image/png")).toBe("image/png");
    expect(defaultFormat("image/webp")).toBe("image/webp");
    expect(defaultFormat("image/heic")).toBe("image/jpeg");
    expect(defaultFormat("image/gif")).toBe("image/jpeg");
  });
});
