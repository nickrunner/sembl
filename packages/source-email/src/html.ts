import { htmlToText } from "@sembl/source-html";

/** Markers that survive the text pass so blockquote nesting can be rebuilt. */
const QUOTE_OPEN = "\u0000bq+";
const QUOTE_CLOSE = "\u0000bq-";

/** Elements a mail client hides: preheaders, tracking scaffolding. */
const HIDDEN_ELEMENT = /<(span|div|p|td|table|font)\b[^>]*\bstyle\s*=\s*(["'])[^"']*display\s*:\s*none[^"']*\2[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Zero-width characters marketing mail pads its preheader with. */
const INVISIBLE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]+/g;

/**
 * Convert an HTML body to text the same way `@sembl/source-html` does, with
 * the differences an email needs:
 *
 * - `<blockquote>` content comes out `>`-prefixed, one level per nesting,
 *   so {@link stripQuotedReplies} sees an HTML reply the way it sees a
 *   plain-text one. Gmail's `gmail_quote`, Apple Mail's and Outlook's
 *   quoting all render as blockquotes.
 * - Hidden elements — `display:none` preheaders, the zero-width padding
 *   marketing mail hides behind the subject line — are removed.
 * - Images never carry text here, so tracking pixels leave nothing behind;
 *   link targets are dropped with the tags, so a tracking URL leaves only
 *   its link text.
 */
export function emailHtmlToText(html: string): string {
  let marked = html.replace(HIDDEN_ELEMENT, " ");
  marked = marked.replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_OPEN}\n`).replace(/<\/blockquote\s*>/gi, `\n${QUOTE_CLOSE}\n`);
  // Outlook separates the reply from the quoted message with a rule.
  marked = marked.replace(/<hr\b[^>]*>/gi, "\n");
  const text = htmlToText(marked);

  const out: string[] = [];
  let depth = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === QUOTE_OPEN) {
      depth += 1;
      continue;
    }
    if (trimmed === QUOTE_CLOSE) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    // A blank line inside a quote stays blank: a bare ">" would only pile up.
    out.push(depth > 0 && trimmed ? `${"> ".repeat(depth)}${trimmed}` : depth > 0 ? "" : line);
  }
  return out
    .join("\n")
    .replace(INVISIBLE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
