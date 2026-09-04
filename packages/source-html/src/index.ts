import type { Source } from "@sembl/core";
import { extractJsonLd, extractMeta, htmlToText } from "./html-to-text.js";

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
 * Build a labelled SEMBL source from a page, ready to pass to any coercion or
 * to `sembl()`.
 */
export function htmlSource(html: string, label?: string, options?: HtmlSourceOptions): Source {
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
export function preprocessHtml(options?: HtmlSourceOptions): (source: Source) => Source {
  return (source) => ({ ...source, text: pageToText(source.text, options) });
}
