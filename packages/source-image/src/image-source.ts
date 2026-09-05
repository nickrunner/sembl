import { readFile } from "node:fs/promises";
import type { ImageMediaType, ImageSource, Source, TextSource } from "@sembl/core";
import { ImageSourceError } from "./errors.js";
import { extractExif } from "./exif.js";
import type { ImageMetadata } from "./exif.js";
import { metadataLabel, renderImageMetadata } from "./render.js";
import { detectImageType, imageTypeName, isSupportedImageType } from "./sniff.js";

/**
 * The largest image {@link imageSource} accepts by default: 20 MB, the cap
 * OpenAI enforces per image. Anthropic's is 5 MB, so a photo straight off
 * a phone (typically 2–6 MB) can pass this check and still be refused by
 * that provider — run it through a resizer first, which also brings the
 * pixel count down to what the model actually reads.
 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/** The default label when none is given. */
export const DEFAULT_LABEL = "Image";

/** What {@link imageSource} takes: bytes, a file path, or a URL the provider will fetch. */
export type ImageInput = Uint8Array | ArrayBuffer | string | { url: string };

/** Options for {@link imageSource}. */
export interface ImageSourceOptions {
  /**
   * Trust this media type instead of sniffing the bytes. For the rare
   * file whose magic bytes are wrong; the bytes are still size-checked.
   */
  mediaType?: ImageMediaType;
  /** Refuse images larger than this many bytes. Default {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
}

/** Options for {@link imageSources}. */
export interface ImageSourcesOptions extends ImageSourceOptions {
  /**
   * Add a text source beside the image with what its headers say — capture
   * date, GPS position, orientation, camera, dimensions. Default true.
   */
  metadata?: boolean;
}

/**
 * Load bytes from a path, or pass bytes through. A path that cannot be
 * read is an `"unreadable"` error with the cause attached.
 */
export async function readImageBytes(input: Uint8Array | ArrayBuffer | string): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  try {
    return new Uint8Array(await readFile(input));
  } catch (cause) {
    throw new ImageSourceError(`Could not read image file ${JSON.stringify(input)}`, { kind: "unreadable", cause });
  }
}

/**
 * Check bytes against the size limit and the formats the providers accept,
 * returning the media type to send. The point of the sniff is the error
 * message: a HEIC from an iPhone is refused as "HEIC" with the fix named,
 * not as "not an image".
 */
export function checkImageBytes(bytes: Uint8Array, options: ImageSourceOptions = {}): ImageMediaType {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (bytes.length > maxBytes) {
    throw new ImageSourceError(
      `Image is ${formatBytes(bytes.length)}, over the ${formatBytes(maxBytes)} limit; resize it first (see @sembl/source-image-sharp)`,
      { kind: "too_large" },
    );
  }
  if (options.mediaType) return options.mediaType;
  const detected = detectImageType(bytes);
  if (detected === undefined) {
    throw new ImageSourceError(
      `Not a recognised image: no JPEG, PNG, GIF, WebP, HEIC, AVIF or TIFF signature in the first bytes`,
      { kind: "unsupported" },
    );
  }
  if (!isSupportedImageType(detected)) {
    throw new ImageSourceError(
      `${imageTypeName(detected)} images are not accepted by the providers; convert to JPEG, PNG, GIF or WebP first (@sembl/source-image-sharp can, where its libvips decodes ${imageTypeName(detected)})`,
      { kind: "unsupported" },
    );
  }
  return detected;
}

/**
 * Build an image source from bytes, a file path, or a URL.
 *
 * Bytes and paths are sniffed for their format and checked against
 * `maxBytes`; an unsupported format or an oversized file is an
 * {@link ImageSourceError} with a `kind` to branch on. A `{ url }` is passed
 * through untouched for the provider to fetch — use {@link fetchImages} to
 * download it here and get the same checks.
 */
export async function imageSource(input: ImageInput, label?: string, options: ImageSourceOptions = {}): Promise<ImageSource> {
  if (typeof input === "object" && !(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) {
    return label ? { label, image: { url: input.url } } : { image: { url: input.url } };
  }
  const bytes = await readImageBytes(input);
  const mediaType = checkImageBytes(bytes, options);
  return label ? { label, image: { data: bytes, mediaType } } : { image: { data: bytes, mediaType } };
}

/**
 * The text source that carries an image's metadata, labelled
 * `"<label> (photo metadata)"`. Exported so a resizer pipeline can build
 * it from the EXIF read before stripping.
 */
export function metadataSource(metadata: ImageMetadata, label: string = DEFAULT_LABEL): TextSource {
  return { label: metadataLabel(label), text: renderImageMetadata(metadata) };
}

/**
 * An image as two sources: the picture, and a short text source with what
 * its file says about it — when it was taken, where the camera was, which
 * way up it is, what took it. Pass the result straight to a coercion.
 *
 * The metadata source is the reason to prefer this over {@link imageSource}
 * for photographs. A model reading a picture can only guess at a date or a
 * place; the file's EXIF states them. Provenance can then cite the metadata
 * source for an address inferred from GPS, and a review UI can show the
 * coordinates that backed it.
 *
 * A `{ url }` input yields the image source alone: there are no bytes here
 * to read headers from.
 */
export async function imageSources(input: ImageInput, label: string = DEFAULT_LABEL, options: ImageSourcesOptions = {}): Promise<Source[]> {
  const { metadata = true, ...rest } = options;
  const image = await imageSource(input, label, rest);
  if (!metadata || !("data" in image.image) || typeof image.image.data === "string") return [image];
  return [image, metadataSource(extractExif(image.image.data), label)];
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KB`;
  return `${n} bytes`;
}
