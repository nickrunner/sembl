import type { TextSource } from "@sembl/core";
import { decodeEntities, extractJsonLd, extractMeta, htmlToText } from "./html-to-text.js";

export { htmlToText, extractJsonLd, extractMeta, decodeEntities } from "./html-to-text.js";

/** Options for {@link htmlSource} and {@link pageToText}. */
export interface HtmlSourceOptions {
  /** Include JSON-LD blocks ahead of the body text. Default true. */
  jsonLd?: boolean;
  /** Include the title and meta tags ahead of the body text. Default true. */
  meta?: boolean;
  /** Include the body text. Default true. */
  body?: boolean;
}

/**
 * Render a page as text for extraction.
 *
 * Structured data comes first — the title and meta tags, then any JSON-LD —
 * and the readable body last. That order is deliberate: SEMBL's default
 * truncation keeps the head of a source, so on a page that blows the input
 * budget the parts most likely to hold clean facts are the parts that
 * survive.
 */
export function pageToText(html: string, options: HtmlSourceOptions = {}): string {
  const { jsonLd = true, meta = true, body = true } = options;
  const sections: string[] = [];

  if (meta) {
    const tags = extractMeta(html);
    const lines = Object.entries(tags).map(([key, value]) => `${key}: ${value}`);
    if (lines.length > 0) sections.push(`Page metadata:\n${lines.join("\n")}`);
  }

  if (jsonLd) {
    const blocks = extractJsonLd(html);
    if (blocks.length > 0) {
      sections.push(
        `Structured data (JSON-LD):\n${blocks.map((b) => JSON.stringify(b)).join("\n")}`,
      );
    }
  }

  if (body) {
    const text = htmlToText(html);
    if (text) sections.push(`Page text:\n${text}`);
  }

  return sections.join("\n\n");
}

/**
 * A page as two sources: the structured data (title, meta tags, JSON-LD)
 * and the readable text, each labelled. The structured source is short, so
 * SEMBL's budget — which cuts long sources first — never touches it; a huge
 * page loses body text, never its JSON-LD. Pass the result straight to a
 * coercion. Only the sources that have content are returned.
 */
export function htmlSources(html: string, label = "Page", options: HtmlSourceOptions = {}): TextSource[] {
  const { body = true } = options;
  const structured = pageToText(html, { ...options, body: false });
  const text = body ? pageToText(html, { meta: false, jsonLd: false, body: true }) : "";
  const sources: TextSource[] = [];
  if (structured) sources.push({ label: `${label} (structured data)`, text: structured });
  if (text) sources.push({ label, text });
  return sources;
}

/** An image the page shows, with whatever size hints it gave. */
export interface HarvestedImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

/** Options for {@link extractImages}. */
export interface ExtractImagesOptions {
  /** Resolves relative URLs. Without it, relative URLs are dropped. */
  baseUrl?: string;
  /** Most images to return, in page order with meta images first. Default 50. */
  max?: number;
  /**
   * Drop images whose declared width or height is under this many pixels.
   * Undeclared sizes are kept. Default 100.
   */
  minSize?: number;
}

/** Path words that mark chrome rather than content. */
const JUNK = /(?:^|[\/_.-])(?:logo|icon|favicon|sprite|avatar|badge|pixel|tracking|blank|spacer|placeholder|loading|spinner|arrow|flag|emoji|button|banner-ad|ads?)(?:[\/_.-]|$)/i;

function toAbsolute(url: string, baseUrl: string | undefined): string | undefined {
  const trimmed = decodeEntities(url.trim());
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:") || trimmed.startsWith("javascript:")) return undefined;
  try {
    const absolute = baseUrl ? new URL(trimmed, baseUrl) : new URL(trimmed);
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return undefined;
    return absolute.href;
  } catch {
    return undefined;
  }
}

function isJunk(url: string): boolean {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  return JUNK.test(path) || /\.(?:svg|gif|ico|bmp)$/i.test(path);
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

function dimension(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The images a page shows, for a gallery or a review UI: OpenGraph and
 * Twitter card images first, then JSON-LD `image` values, then `<img>`
 * tags including lazy-loaded ones and the largest `srcset` candidate.
 * Tracking pixels, icons, logos, sprites and vector chrome are dropped by
 * size hints and path words, `data:` URIs are ignored, and duplicates are
 * folded. Returns nothing rather than guessing when no `baseUrl` is given
 * and a URL is relative.
 */
export function extractImages(html: string, options: ExtractImagesOptions = {}): HarvestedImage[] {
  const { baseUrl, max = 50, minSize = 100 } = options;
  const seen = new Set<string>();
  const images: HarvestedImage[] = [];
  const add = (raw: string | undefined, extra: Omit<HarvestedImage, "url"> = {}) => {
    if (!raw || images.length >= max) return;
    const url = toAbsolute(raw, baseUrl);
    if (!url || seen.has(url) || isJunk(url)) return;
    if ((extra.width !== undefined && extra.width < minSize) || (extra.height !== undefined && extra.height < minSize)) return;
    seen.add(url);
    const image: HarvestedImage = { url };
    if (extra.alt) image.alt = extra.alt;
    if (extra.width !== undefined) image.width = extra.width;
    if (extra.height !== undefined) image.height = extra.height;
    images.push(image);
  };

  const meta = extractMeta(html);
  for (const key of ["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"]) {
    add(meta[key]);
  }

  const visit = (value: unknown): void => {
    if (typeof value === "string") add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.url === "string" && (record["@type"] === "ImageObject" || "contentUrl" in record)) add(record.url);
      if (typeof record.contentUrl === "string") add(record.contentUrl);
      if ("image" in record) visit(record.image);
      if ("photo" in record) visit(record.photo);
      for (const [key, child] of Object.entries(record)) {
        if (key !== "image" && key !== "photo" && child && typeof child === "object") visit(child);
      }
    }
  };
  for (const block of extractJsonLd(html)) visit(block);

  const tags = /<img\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    const attrs = match[1];
    const width = dimension(attr(attrs, "width"));
    const height = dimension(attr(attrs, "height"));
    const alt = attr(attrs, "alt")?.trim();
    const srcset = attr(attrs, "srcset") ?? attr(attrs, "data-srcset");
    let candidate = attr(attrs, "src") ?? attr(attrs, "data-src") ?? attr(attrs, "data-lazy-src");
    if (srcset) {
      // The widest candidate is the one worth keeping.
      const best = srcset
        .split(",")
        .map((entry) => entry.trim().split(/\s+/))
        .map(([url, size]) => ({ url, w: size?.endsWith("w") ? parseInt(size, 10) : 0 }))
        .sort((a, b) => b.w - a.w)[0];
      if (best?.url) candidate = best.url;
    }
    add(candidate, { alt: alt || undefined, width, height });
  }

  return images;
}

/**
 * Build a labelled SEMBL source from a page, ready to pass to any coercion or
 * to `sembl()`. For a page that may blow the input budget, prefer
 * {@link htmlSources}, which keeps the structured data in its own source.
 */
export function htmlSource(html: string, label?: string, options?: HtmlSourceOptions): TextSource {
  const text = pageToText(html, options);
  return label ? { label, text } : { text };
}

/**
 * A `preprocess` hook that converts every source's text from HTML, for the
 * case where the sources are pages but you would rather keep the fetch and
 * the coercion apart:
 *
 * ```ts
 * await coerce(pages, { provider, schema, preprocess: preprocessHtml() });
 * ```
 */
export function preprocessHtml(options?: HtmlSourceOptions): (source: TextSource) => TextSource {
  return (source) => ({ ...source, text: pageToText(source.text, options) });
}
