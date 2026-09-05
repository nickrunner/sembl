import sharp from "sharp";
import { ImageSourceError, detectImageType, imageTypeName } from "@sembl/source-image";
import type { ImageResizer, ResizeFormat, ResizeOptions, ResizedImage } from "@sembl/source-image";

/**
 * The default long edge, 1568 pixels: the size Anthropic recommends and
 * the point past which its API downscales anyway.
 *
 * The reasoning is tokens. Anthropic charges roughly `width × height / 750`
 * tokens per image; at 1568 on the long edge a 4:3 photo is about 1.15
 * megapixels, ~1 600 tokens. A 12-megapixel phone photo sent as is costs
 * nothing more — the API scales it down first — but takes ten times the
 * bytes to upload, can exceed the 5 MB per-image cap, and OpenAI's
 * high-detail mode tiles it into more 512-pixel squares. Below 1568 the
 * model starts to lose small text on signs and forms. So: downscale to
 * 1568, never enlarge.
 */
export const DEFAULT_MAX_EDGE = 1568;

/** The default JPEG/WebP quality. High enough that text stays crisp, well under the size caps. */
export const DEFAULT_QUALITY = 85;

/** Options for {@link SharpResizer}. */
export interface SharpResizerOptions extends ResizeOptions {
  /**
   * Refuse to decode images with more pixels than this, as sharp's
   * `limitInputPixels`. Default is sharp's own (268 megapixels). A
   * decompression bomb from a scraped page is the case to bound.
   */
  limitInputPixels?: number;
}

/**
 * Whether this build of sharp can decode HEIF containers at all. The
 * prebuilt binaries ship libheif with AV1 codecs (AVIF) and no HEVC
 * decoder, so this being true does not mean an iPhone HEIC will decode:
 * that is only known by trying, which {@link SharpResizer.resize} does,
 * turning the failure into an `ImageSourceError` of kind `"unsupported"`.
 */
export function sharpSupportsHeif(): boolean {
  // `heif` is in the typings, but read defensively: an older or custom build may lack it.
  const formats = sharp.format as unknown as Partial<Record<string, { input?: { buffer?: boolean } }>>;
  return formats.heif?.input?.buffer === true;
}

/**
 * An {@link ImageResizer} on sharp (libvips).
 *
 * Downscales to `maxEdge`, rotates upright from the EXIF orientation,
 * re-encodes as JPEG, PNG or WebP, and strips the metadata — so read it
 * first, which `prepareImages` does. Converts HEIC/HEIF when the installed
 * libvips has an HEVC decoder; the prebuilt binaries do not, and then a
 * HEIC is refused as `"unsupported"` with a message that says so.
 */
export class SharpResizer implements ImageResizer {
  constructor(private readonly defaults: SharpResizerOptions = {}) {}

  async resize(image: { data: Uint8Array; mediaType: string }, options: ResizeOptions = {}): Promise<ResizedImage> {
    const {
      maxEdge = DEFAULT_MAX_EDGE,
      quality = DEFAULT_QUALITY,
      stripMetadata = true,
      autoOrient = true,
      limitInputPixels,
    } = { ...this.defaults, ...options };
    const detected = detectImageType(image.data);
    const inputType = detected ?? image.mediaType;
    const format = options.format ?? this.defaults.format ?? defaultFormat(inputType);

    if ((detected === "image/heic" || detected === "image/heif") && !sharpSupportsHeif()) {
      throw new ImageSourceError(
        `${imageTypeName(detected)} cannot be decoded: this build of sharp has no HEIF support. Install a sharp built against a libvips with libheif and an HEVC decoder, or convert the image before it gets here.`,
        { kind: "unsupported" },
      );
    }

    let pipeline = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
      ...(limitInputPixels !== undefined ? { limitInputPixels } : {}),
    });
    if (autoOrient) pipeline = pipeline.rotate();
    if (!stripMetadata) pipeline = pipeline.keepMetadata();
    pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });
    switch (format) {
      case "image/jpeg": pipeline = pipeline.jpeg({ quality }); break;
      case "image/webp": pipeline = pipeline.webp({ quality }); break;
      case "image/png": pipeline = pipeline.png(); break;
    }

    try {
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mediaType: format, width: info.width, height: info.height };
    } catch (cause) {
      // libvips prefixes the real reason with a line per failed seek; the last line is the one that says why.
      const message = (cause instanceof Error ? cause.message : String(cause)).trim().split("\n").pop() ?? "";
      if (detected === "image/heic" || detected === "image/heif") {
        throw new ImageSourceError(
          `${imageTypeName(detected)} cannot be decoded by this build of sharp (${message}). Prebuilt sharp binaries ship libheif without an HEVC decoder; install a sharp built against a libvips that has one, or convert the image before it gets here.`,
          { kind: "unsupported", cause },
        );
      }
      if (detected === undefined || /unsupported image format|Input buffer contains unsupported/i.test(message)) {
        throw new ImageSourceError(`sharp cannot decode this ${imageTypeName(detected)} input: ${message}`, { kind: "unsupported", cause });
      }
      throw new ImageSourceError(`sharp failed to process the image: ${message}`, { kind: "unsupported", cause });
    }
  }
}

/**
 * The output format for an input: PNG stays PNG (screenshots, renders and
 * anything with transparency lose nothing), WebP stays WebP, everything
 * else — JPEG, HEIC, TIFF, GIF, AVIF, BMP — becomes JPEG.
 */
export function defaultFormat(inputType: string): ResizeFormat {
  if (inputType === "image/png") return "image/png";
  if (inputType === "image/webp") return "image/webp";
  return "image/jpeg";
}
