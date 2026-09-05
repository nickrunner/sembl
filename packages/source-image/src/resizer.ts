import type { ImageMediaType, ImageSource, Source } from "@sembl/core";
import { imageDimensions } from "./dimensions.js";
import { ImageSourceError } from "./errors.js";
import { extractExif } from "./exif.js";
import { DEFAULT_LABEL, metadataSource } from "./image-source.js";
import { METADATA_LABEL_SUFFIX, metadataLabel } from "./render.js";
import { detectImageType, imageTypeName, isSupportedImageType } from "./sniff.js";

/** The formats a resizer can be asked to produce. */
export type ResizeFormat = "image/jpeg" | "image/png" | "image/webp";

/** What to do to an image before it goes to the model. */
export interface ResizeOptions {
  /**
   * Scale the picture so its longer edge is at most this many pixels. Never
   * enlarges. A resizer's default is its own; `@sembl/source-image-sharp`
   * uses 1568, the long edge Anthropic recommends.
   */
  maxEdge?: number;
  /** The output format. A resizer's default keeps the input's where it can. */
  format?: ResizeFormat;
  /** Encoder quality for lossy formats, 1–100. */
  quality?: number;
  /**
   * Drop EXIF, XMP, ICC and the rest. Default true: a stripped image is
   * smaller, and once the metadata has been read into its own text source
   * the model gains nothing from the bytes. Read it first — see
   * {@link prepareImages}.
   */
  stripMetadata?: boolean;
  /**
   * Rotate the pixels according to the EXIF orientation so the output is
   * upright with orientation 1. Default true; a model reads an upright
   * sign better than one on its side.
   */
  autoOrient?: boolean;
}

/** An image after resizing: bytes the providers accept, and the size they are. */
export interface ResizedImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

/**
 * The seam this package's resizing is built around.
 *
 * Reading headers needs no decoder, but scaling pixels, rotating them,
 * or converting a HEIC does — and decoders are native code. So the
 * decoder lives behind this interface, `@sembl/source-image-sharp`
 * provides one on `sharp`, and this package stays dependency-free.
 * A resizer may receive any format {@link detectImageType} names, HEIC
 * included, and answers with one every provider accepts — or throws an
 * {@link ImageSourceError} of kind `"unsupported"` when it cannot.
 */
export interface ImageResizer {
  resize(image: { data: Uint8Array; mediaType: string }, options?: ResizeOptions): Promise<ResizedImage>;
}

/**
 * A resizer that resizes nothing. The bytes go back as they came, with the
 * size from their header; a format the providers do not accept is refused
 * as `"unsupported"`, since there is no decoder here to convert it. For
 * tests, and for pipelines that want {@link prepareImages}'s metadata
 * handling without a native dependency.
 */
export class NoopResizer implements ImageResizer {
  async resize(image: { data: Uint8Array; mediaType: string }): Promise<ResizedImage> {
    const detected = detectImageType(image.data) ?? image.mediaType;
    if (!isSupportedImageType(detected)) {
      throw new ImageSourceError(
        `NoopResizer cannot convert ${imageTypeName(detected as never)}; use a resizer with a decoder such as @sembl/source-image-sharp`,
        { kind: "unsupported" },
      );
    }
    const dims = imageDimensions(image.data);
    return { data: image.data, mediaType: detected, width: dims?.width ?? 0, height: dims?.height ?? 0 };
  }
}

/** Options for {@link prepareImages}. */
export interface PrepareImagesOptions extends ResizeOptions {
  /**
   * Add a `"<label> (photo metadata)"` text source after each image whose
   * headers were readable, unless one with that label already follows it
   * (as it does when the sources came from `imageSources`). Default true.
   * The EXIF is read from the original bytes, before the resizer strips
   * them.
   */
  metadata?: boolean;
  /**
   * What to do when the resizer throws for one image: `"throw"` (default)
   * fails the whole call; `"skip"` drops that image and its metadata.
   */
  onError?: "throw" | "skip";
}

/**
 * Run every inline image source through a resizer, leaving text, document
 * and URL sources as they are. Each image's EXIF is read before the
 * resizer sees it, so the metadata source is built from the original —
 * a stripped, re-encoded JPEG has no GPS to read.
 *
 * ```ts
 * const sources = await prepareImages(
 *   [{ label: "Photo", image: { data: bytes, mediaType: "image/jpeg" } }, { label: "Email", text }],
 *   new SharpResizer(),
 *   { maxEdge: 1568 },
 * );
 * ```
 */
export async function prepareImages(
  sources: readonly Source[],
  resizer: ImageResizer,
  options: PrepareImagesOptions = {},
): Promise<Source[]> {
  const { metadata = true, onError = "throw", ...resize } = options;
  const out: Source[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (!("image" in source) || !("data" in source.image)) {
      out.push(source);
      continue;
    }
    const data = typeof source.image.data === "string" ? fromBase64(source.image.data) : source.image.data;
    const label = source.label ?? DEFAULT_LABEL;
    const next = sources[i + 1];
    const alreadyHasMetadata =
      next !== undefined && "text" in next && next.label === metadataLabel(label);
    const exif = metadata && !alreadyHasMetadata ? extractExif(data) : undefined;

    let resized: ResizedImage;
    try {
      resized = await resizer.resize({ data, mediaType: source.image.mediaType }, resize);
    } catch (error) {
      if (onError === "skip") {
        if (alreadyHasMetadata) i++; // drop the metadata that went with it
        continue;
      }
      throw error;
    }
    const image: ImageSource = source.label !== undefined
      ? { label: source.label, image: { data: resized.data, mediaType: resized.mediaType } }
      : { image: { data: resized.data, mediaType: resized.mediaType } };
    out.push(image);
    if (exif) out.push(metadataSource(exif, label));
  }
  return out;
}

/** Whether a text source is the metadata companion of an image, by its label. */
export function isMetadataSource(source: Source): boolean {
  return "text" in source && typeof source.label === "string" && source.label.endsWith(METADATA_LABEL_SUFFIX);
}

/** Decode base64 to bytes, with Node's Buffer or the browser's atob. */
export function fromBase64(text: string): Uint8Array {
  const buffer = (globalThis as { Buffer?: { from(s: string, enc: "base64"): Uint8Array } }).Buffer;
  if (buffer) return new Uint8Array(buffer.from(text, "base64"));
  const decode = (globalThis as { atob?: (s: string) => string }).atob;
  if (!decode) throw new Error("No base64 decoder available: neither Buffer nor atob is defined");
  const binary = decode(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
