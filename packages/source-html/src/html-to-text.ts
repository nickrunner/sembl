/**
 * A small, dependency-free HTML-to-text pass tuned for feeding a page to a
 * language model rather than for rendering it.
 *
 * It is regex-based, so it is not a parser: malformed markup degrades to
 * slightly worse text rather than to an error, which is the right trade for
 * scraped input. Structured data the page already carries — JSON-LD blocks,
 * OpenGraph and meta tags, the title — is pulled out separately so it can be
 * placed ahead of the body text, where head-keeping truncation preserves it.
 */

/** Elements whose contents never carry readable text. */
const DROP_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe", "head"];

/** Elements that end a line when they open or close. */
const BLOCK_ELEMENTS = [
  "address", "article", "aside", "blockquote", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "ul",
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“",
  rdquo: "”", bull: "•", middot: "·", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢",
  frac12: "½", frac14: "¼", frac34: "¾", times: "×", laquo: "«", raquo: "»",
};

/** Decode numeric and the common named character references. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1].toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** Remove an element and everything inside it, for each name given. */
function dropElements(html: string, names: readonly string[]): string {
  return names.reduce(
    (acc, name) => acc.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}\\s*>`, "gi"), " "),
    html,
  );
}

/**
 * Reduce a page's markup to readable text: comments and non-text elements
 * removed, block boundaries turned into line breaks, list items bulleted,
 * entities decoded, whitespace collapsed.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, " ");
  text = dropElements(text, DROP_ELEMENTS);
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(new RegExp(`</?(?:${BLOCK_ELEMENTS.join("|")})\\b[^>]*>`, "gi"), "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/[ \t\f\v ]+/g, " ");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/**
 * Every parseable `<script type="application/ld+json">` block on the page.
 * A block that fails to parse is skipped: it is the page's bug, not ours.
 */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[1].trim()));
    } catch {
      // Skip a malformed block rather than lose the rest of the page.
    }
  }
  return blocks;
}

/** Read one attribute off a tag's attribute string. */
function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/**
 * The page's `<title>` and its `<meta>` tags keyed by `property` or `name`
 * — OpenGraph (`og:*`), Twitter cards, `description`, and so on. Later tags
 * with the same key win, matching how most scrapers read them.
 */
export function extractMeta(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (title) {
    const text = decodeEntities(title[1]).replace(/\s+/g, " ").trim();
    if (text) meta.title = text;
  }
  const pattern = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1];
    const key = attribute(attrs, "property") ?? attribute(attrs, "name");
    const content = attribute(attrs, "content");
    if (key && content !== undefined && content.trim()) {
      meta[key.toLowerCase()] = content.trim();
    }
  }
  return meta;
}
