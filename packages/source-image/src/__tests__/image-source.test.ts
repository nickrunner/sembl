import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isImageSource, isTextSource, renderSources, toSources } from "@sembl/core";
import type { ImageSource, TextSource } from "@sembl/core";
import {
  DEFAULT_MAX_BYTES,
  ImageSourceError,
  extractExif,
  imageSource,
  imageSources,
  metadataLabel,
  renderImageMetadata,
} from "../index.js";
import { YACHATS, heicHeader, jpegWithExif, png, tiffHeader, tinyJpeg } from "./fixtures.js";

async function failure(promise: Promise<unknown>): Promise<ImageSourceError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ImageSourceError);
  return error as ImageSourceError;
}

describe("imageSource", () => {
  it("sniffs bytes into a labelled image source", async () => {
    const source = await imageSource(tinyJpeg(), "Photo");
    expect(source).toEqual({ label: "Photo", image: { data: tinyJpeg(), mediaType: "image/jpeg" } });
    expect(isImageSource(source)).toBe(true);
  });

  it("takes an ArrayBuffer and leaves the label off when none is given", async () => {
    const bytes = png(3, 3);
    const source = await imageSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(source.label).toBeUndefined();
    expect("data" in source.image && source.image.mediaType).toBe("image/png");
  });

  it("reads a file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sembl-image-"));
    const path = join(dir, "sign.jpg");
    await writeFile(path, tinyJpeg());
    const source = await imageSource(path, "Sign");
    expect("data" in source.image && source.image.mediaType).toBe("image/jpeg");
    expect("data" in source.image && (source.image.data as Uint8Array).length).toBe(tinyJpeg().length);
  });

  it("reports an unreadable path", async () => {
    const error = await failure(imageSource("/nonexistent/photo.jpg"));
    expect(error.kind).toBe("unreadable");
    expect(error.cause).toBeDefined();
  });

  it("passes a URL through for the provider to fetch", async () => {
    expect(await imageSource({ url: "https://example.com/a.jpg" }, "Remote")).toEqual({
      label: "Remote",
      image: { url: "https://example.com/a.jpg" },
    });
  });

  it("refuses HEIC and TIFF by name, and non-images plainly", async () => {
    const heic = await failure(imageSource(heicHeader()));
    expect(heic.kind).toBe("unsupported");
    expect(heic.message).toContain("HEIC");
    expect(heic.message).toContain("source-image-sharp");
    const tiff = await failure(imageSource(tiffHeader()));
    expect(tiff.message).toContain("TIFF");
    const html = await failure(imageSource(new TextEncoder().encode("<html>nope</html>")));
    expect(html.kind).toBe("unsupported");
    expect(html.message).toContain("Not a recognised image");
  });

  it("enforces maxBytes, defaulting to 20 MB", async () => {
    expect(DEFAULT_MAX_BYTES).toBe(20 * 1024 * 1024);
    const error = await failure(imageSource(tinyJpeg(), "Photo", { maxBytes: 100 }));
    expect(error.kind).toBe("too_large");
    expect(error.message).toContain("270 bytes");
    expect(error.message).toContain("100 bytes");
  });

  it("lets a media type override the sniff", async () => {
    const source = await imageSource(new Uint8Array(64), "Odd", { mediaType: "image/gif" });
    expect("data" in source.image && source.image.mediaType).toBe("image/gif");
  });
});

describe("imageSources", () => {
  it("returns the image and a metadata text source beside it", async () => {
    const sources = await imageSources(jpegWithExif(YACHATS), "Listing photo");
    expect(sources).toHaveLength(2);
    const [image, meta] = sources as [ImageSource, TextSource];
    expect(isImageSource(image)).toBe(true);
    expect(image.label).toBe("Listing photo");
    expect(isTextSource(meta)).toBe(true);
    expect(meta.label).toBe("Listing photo (photo metadata)");
    expect(meta.label).toBe(metadataLabel("Listing photo"));
    expect(meta.text).toContain("Taken: 2025-06-14 09:12:30 (camera clock, UTC-07:00)");
    expect(meta.text).toContain("GPS position of the camera: 44.311400, -124.104900");
    expect(meta.text).toContain("altitude 12 m above sea level");
    expect(meta.text).toContain("Orientation: 6");
    expect(meta.text).toContain("Camera: Apple iPhone 15 Pro");
    expect(meta.text).toContain("Software: 17.5.1");
    expect(meta.text).toContain("Dimensions: 4×3 pixels (JPEG)");
    expect(meta.text).toContain("Description: Sea Cabin from the beach");
    expect(meta.text).toContain("Comment: Listing photo");
    expect(meta.text.split("\n")[0]).toContain("not read from the picture");
  });

  it("renders as two source blocks the model can tell apart", async () => {
    const rendered = renderSources(toSources(await imageSources(jpegWithExif(YACHATS), "Photo")));
    expect(rendered).toContain('<source label="Photo" type="image/jpeg" />');
    expect(rendered).toContain('<source label="Photo (photo metadata)">');
  });

  it("says so when there is no EXIF, and when EXIF has no date or position", async () => {
    const [, plain] = (await imageSources(tinyJpeg(), "Screenshot")) as [ImageSource, TextSource];
    expect(plain.text).toContain("The file carries no EXIF");
    expect(plain.text).toContain("Dimensions: 4×3 pixels (JPEG)");
    const [, sparse] = (await imageSources(jpegWithExif({ make: "Canon", model: "EOS R6" }), "Photo")) as [ImageSource, TextSource];
    expect(sparse.text).toContain("Camera: Canon EOS R6");
    expect(sparse.text).toContain("No capture date or GPS position is recorded in the file.");
  });

  it("defaults the label to Image and can leave the metadata out", async () => {
    const sources = await imageSources(tinyJpeg());
    expect(sources[0].label).toBe("Image");
    expect(sources[1].label).toBe("Image (photo metadata)");
    expect(await imageSources(tinyJpeg(), "Photo", { metadata: false })).toHaveLength(1);
  });

  it("gives a URL input the image alone", async () => {
    expect(await imageSources({ url: "https://example.com/a.jpg" }, "Remote")).toHaveLength(1);
  });
});

describe("renderImageMetadata", () => {
  it("does not repeat the make when the model already names it", () => {
    expect(renderImageMetadata({ hasExif: true, make: "Apple", model: "Apple iPhone" })).toContain("Camera: Apple iPhone\n");
  });

  it("omits orientation 1 and uses EXIF dimensions when the header has none", () => {
    const text = renderImageMetadata({ hasExif: true, orientation: 1, exifWidth: 10, exifHeight: 20 });
    expect(text).not.toContain("Orientation");
    expect(text).toContain("Dimensions: 10×20 pixels (from EXIF)");
  });

  it("round-trips through extractExif for a WebP with no EXIF", () => {
    const text = renderImageMetadata(extractExif(png(5, 6)));
    expect(text).toContain("Dimensions: 5×6 pixels (PNG)");
  });
});
