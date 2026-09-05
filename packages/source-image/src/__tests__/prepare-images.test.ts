import { describe, it, expect } from "vitest";
import { toBase64 } from "@sembl/core";
import type { Source, TextSource } from "@sembl/core";
import { ImageSourceError, NoopResizer, imageSources, isMetadataSource, prepareImages } from "../index.js";
import type { ImageResizer, ResizeOptions, ResizedImage } from "../index.js";
import { YACHATS, heicHeader, jpegWithExif, png, tinyJpeg } from "./fixtures.js";

/** A resizer that swaps every image for a 2×2 PNG and records what it was asked. */
class FakeResizer implements ImageResizer {
  readonly calls: Array<{ mediaType: string; bytes: number; options: ResizeOptions | undefined }> = [];
  constructor(private readonly fail?: (mediaType: string) => boolean) {}
  async resize(image: { data: Uint8Array; mediaType: string }, options?: ResizeOptions): Promise<ResizedImage> {
    this.calls.push({ mediaType: image.mediaType, bytes: image.data.length, options });
    if (this.fail?.(image.mediaType)) throw new ImageSourceError(`cannot ${image.mediaType}`, { kind: "unsupported" });
    return { data: png(2, 2), mediaType: "image/png", width: 2, height: 2 };
  }
}

describe("prepareImages", () => {
  it("runs every inline image through the resizer and leaves the rest alone", async () => {
    const resizer = new FakeResizer();
    const sources: Source[] = [
      { label: "Email", text: "Pets welcome." },
      { label: "Photo", image: { data: jpegWithExif(YACHATS), mediaType: "image/jpeg" } },
      { label: "Remote", image: { url: "https://x/a.jpg" } },
      { label: "Brochure", document: { data: new Uint8Array(4), mediaType: "application/pdf" } },
    ];
    const out = await prepareImages(sources, resizer, { maxEdge: 800, format: "image/png" });
    expect(out.map((s) => s.label)).toEqual(["Email", "Photo", "Photo (photo metadata)", "Remote", "Brochure"]);
    expect(out[1]).toEqual({ label: "Photo", image: { data: png(2, 2), mediaType: "image/png" } });
    expect(out[3]).toBe(sources[2]);
    expect(out[4]).toBe(sources[3]);
    expect(resizer.calls).toEqual([{ mediaType: "image/jpeg", bytes: jpegWithExif(YACHATS).length, options: { maxEdge: 800, format: "image/png" } }]);
  });

  it("reads the EXIF before the resizer strips it", async () => {
    const out = await prepareImages([{ label: "Photo", image: { data: jpegWithExif(YACHATS), mediaType: "image/jpeg" } }], new FakeResizer());
    const meta = out[1] as TextSource;
    expect(isMetadataSource(meta)).toBe(true);
    expect(meta.text).toContain("GPS position of the camera: 44.311400, -124.104900");
    // The image itself is the resizer's output, which carries none of it.
    expect(out[0]).toEqual({ label: "Photo", image: { data: png(2, 2), mediaType: "image/png" } });
  });

  it("does not add a second metadata source after one imageSources already made", async () => {
    const sources = await imageSources(jpegWithExif(YACHATS), "Photo");
    const out = await prepareImages(sources, new FakeResizer());
    expect(out.map((s) => s.label)).toEqual(["Photo", "Photo (photo metadata)"]);
    expect(out[1]).toBe(sources[1]);
  });

  it("decodes base64 data, defaults the metadata label, and can skip metadata", async () => {
    const out = await prepareImages([{ image: { data: toBase64(jpegWithExif(YACHATS)), mediaType: "image/jpeg" } }], new FakeResizer());
    expect(out.map((s) => s.label)).toEqual([undefined, "Image (photo metadata)"]);
    expect((out[1] as TextSource).text).toContain("Camera: Apple iPhone 15 Pro");
    const bare = await prepareImages([{ image: { data: tinyJpeg(), mediaType: "image/jpeg" } }], new FakeResizer(), { metadata: false });
    expect(bare).toHaveLength(1);
  });

  it("throws by default when the resizer cannot, or skips the image and its metadata on request", async () => {
    // Core's ImageSource type only names the four accepted formats; a HEIC arrives mislabelled as JPEG.
    const heic: Source = { label: "Phone photo", image: { data: heicHeader(), mediaType: "image/jpeg" } };
    const fine: Source = { label: "Other", image: { data: tinyJpeg(), mediaType: "image/jpeg" } };
    const refusesHeic = () => new FakeResizer((type) => type === "image/heic");
    // The fake decides by the media type it is given, so hand it HEIC by name for the failure.
    const asHeic = (s: Source): Source => ({ ...s, image: { data: heicHeader(), mediaType: "image/heic" as never } });

    await expect(prepareImages([asHeic(heic)], refusesHeic())).rejects.toBeInstanceOf(ImageSourceError);

    const out = await prepareImages(
      [asHeic(heic), { label: "Phone photo (photo metadata)", text: "…" }, fine],
      refusesHeic(),
      { onError: "skip" },
    );
    expect(out.map((s) => s.label)).toEqual(["Other", "Other (photo metadata)"]);
  });
});

describe("NoopResizer", () => {
  it("returns the bytes with their header size and the sniffed type", async () => {
    const out = await new NoopResizer().resize({ data: png(7, 9), mediaType: "image/jpeg" });
    expect(out).toEqual({ data: png(7, 9), mediaType: "image/png", width: 7, height: 9 });
  });

  it("refuses a format the providers do not take", async () => {
    const error = await new NoopResizer().resize({ data: heicHeader(), mediaType: "image/heic" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageSourceError);
    expect((error as ImageSourceError).kind).toBe("unsupported");
    expect((error as ImageSourceError).message).toContain("HEIC");
  });
});
