/**
 * Why turning an image into a source failed, in terms a caller can act on.
 *
 * `"unsupported"` is the bytes: a format no bundled provider takes (HEIC,
 * TIFF, AVIF) or something that is not an image at all. `"too_large"` is
 * the `maxBytes` limit. `"unreadable"` is a path that could not be read.
 * `"fetch"` is a download that failed — a bad status, a wrong content type,
 * a timeout. Only the last is plausibly transient.
 */
export type ImageSourceErrorKind = "unsupported" | "too_large" | "unreadable" | "fetch";

/**
 * Error thrown by everything in `@sembl/source-image` and by the resizers
 * built on it.
 *
 * Branch on `kind` rather than matching the message — messages stay
 * diagnostic and are free to change.
 */
export class ImageSourceError extends Error {
  /** What class of failure this is. */
  public readonly kind: ImageSourceErrorKind;
  /** HTTP status, when the failure came back from a download. */
  public readonly status?: number;

  constructor(message: string, options: { kind: ImageSourceErrorKind; status?: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "ImageSourceError";
    this.kind = options.kind;
    this.status = options.status;
  }
}
