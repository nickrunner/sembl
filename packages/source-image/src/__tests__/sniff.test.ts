import { describe, it, expect } from "vitest";
import { detectImageType, imageDimensions, imageTypeName, sniffImageType } from "../index.js";
import { gifHeader, heicHeader, png, tiffHeader, tinyJpeg, webpExtended, webpLossless, webpLossy } from "./fixtures.js";

describe("sniffImageType", () => {
  it("names the four provider formats from their magic bytes", () => {
    expect(sniffImageType(tinyJpeg())).toBe("image/jpeg");
    expect(sniffImageType(png(2, 2))).toBe("image/png");
    expect(sniffImageType(gifHeader(10, 20))).toBe("image/gif");
    expect(sniffImageType(webpLossy(30, 40))).toBe("image/webp");
  });

  it("returns undefined for formats the providers do not take, and for non-images", () => {
    expect(sniffImageType(heicHeader())).toBeUndefined();
    expect(sniffImageType(tiffHeader())).toBeUndefined();
    expect(sniffImageType(new TextEncoder().encode("<!doctype html><html><body>Not found</body></html>"))).toBeUndefined();
    expect(sniffImageType(new Uint8Array(0))).toBeUndefined();
    expect(sniffImageType(new Uint8Array(5))).toBeUndefined();
  });
});

describe("detectImageType", () => {
  it("names HEIC, HEIF, AVIF, TIFF and BMP so they can be reported", () => {
    expect(detectImageType(heicHeader())).toBe("image/heic");
    expect(detectImageType(heicHeader("mif1", ["mif1", "heic"]))).toBe("image/heic");
    expect(detectImageType(heicHeader("mif1", ["mif1", "heif"]))).toBe("image/heif");
    expect(detectImageType(heicHeader("avif", ["avif", "mif1"]))).toBe("image/avif");
    expect(detectImageType(tiffHeader())).toBe("image/tiff");
    expect(detectImageType(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0]))).toBe("image/tiff");
    expect(detectImageType(Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/bmp");
    expect(detectImageType(heicHeader("isom", ["isom", "mp42"]))).toBeUndefined();
  });

  it("has a human name for every format", () => {
    expect(imageTypeName("image/heic")).toBe("HEIC");
    expect(imageTypeName("image/webp")).toBe("WebP");
    expect(imageTypeName(undefined)).toBe("unknown");
  });
});

describe("imageDimensions", () => {
  it("reads a JPEG's SOF", () => {
    expect(imageDimensions(tinyJpeg())).toEqual({ width: 4, height: 3 });
  });

  it("reads a PNG's IHDR", () => {
    expect(imageDimensions(png(1030, 305))).toEqual({ width: 1030, height: 305 });
  });

  it("reads a GIF's logical screen", () => {
    expect(imageDimensions(gifHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("reads every WebP flavour", () => {
    expect(imageDimensions(webpLossy(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(imageDimensions(webpLossless(1201, 801))).toEqual({ width: 1201, height: 801 });
    expect(imageDimensions(webpExtended(70000, 12))).toEqual({ width: 70000, height: 12 });
  });

  it("gives up quietly on other formats and damaged headers", () => {
    expect(imageDimensions(heicHeader())).toBeUndefined();
    expect(imageDimensions(tinyJpeg().subarray(0, 40))).toBeUndefined();
    expect(imageDimensions(png(2, 2).subarray(0, 20))).toBeUndefined();
    const badWebp = webpLossy(10, 10);
    badWebp[23] = 0x00; // break the VP8 start code
    expect(imageDimensions(badWebp)).toBeUndefined();
    expect(imageDimensions(new Uint8Array(0))).toBeUndefined();
  });

  it("is not fooled by a JPEG whose scan starts before any SOF", () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    expect(imageDimensions(bytes)).toBeUndefined();
  });
});
