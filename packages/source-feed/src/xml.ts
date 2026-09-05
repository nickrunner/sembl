import type { Source } from "@sembl/core";
import { htmlToText } from "@sembl/source-html";
import { FeedError, guardInput, itemLabel, pushScalar, renderOutline, tidyText } from "./shared.js";
import type { OutlineLine, SizeGuardOptions } from "./shared.js";

/** An element in a parsed document. Text children are plain strings. */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

/** Options for {@link parseXml}. */
export interface XmlParseOptions extends SizeGuardOptions {
  /**
   * Keep namespace prefixes on element and attribute names and keep the
   * `xmlns` declarations. Default false: `media:content` becomes `content`,
   * which is what a model needs to read it.
   */
  namespaces?: boolean;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the five XML entities and numeric references; anything else is left as written. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1].toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[ref] ?? match;
  });
}

/** Line number of an offset, for error messages. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00C0-\uFFFF]/;
const WHITESPACE = /\s/;

function stripPrefix(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * Parse a document into an element tree. A small, linear tokenizer of our
 * own rather than a dependency: it handles the prolog, comments, processing
 * instructions, a DOCTYPE with an internal subset (skipped, never fetched),
 * CDATA, entities and self-closing tags, and reports the first structural
 * fault it finds with a line number. Namespace prefixes are stripped
 * unless `namespaces` is set.
 */
export function parseXml(xml: string, options: XmlParseOptions = {}): XmlElement {
  const text = guardInput(xml, "xml", options).replace(/^\uFEFF/, "");
  const keepNs = options.namespaces === true;
  const fail = (message: string, at: number): never => {
    throw new FeedError("xml", message, lineAt(text, at));
  };

  const root: XmlElement = { name: "", attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = text.length;

  const skipTo = (marker: string, from: number, what: string): number => {
    const end = text.indexOf(marker, from);
    if (end === -1) fail(`Unterminated ${what}`, from);
    return end + marker.length;
  };

  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], text.slice(i), stack.length === 1, i);
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], text.slice(i, lt), stack.length === 1, i);
    i = lt;

    if (text.startsWith("<!--", i)) {
      i = skipTo("-->", i + 4, "comment");
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end === -1) fail("Unterminated CDATA section", i);
      if (stack.length === 1) fail("Text outside the root element", i);
      stack[stack.length - 1].children.push(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      i = skipTo("?>", i + 2, "processing instruction");
      continue;
    }
    if (text.startsWith("<!", i)) {
      // A DOCTYPE, possibly with an internal subset in brackets. Skipped
      // entirely; no entity it declares is expanded and nothing is fetched.
      let j = i + 2;
      let depth = 0;
      for (; j < n; j++) {
        const c = text[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth === 0) break;
      }
      if (j >= n) fail("Unterminated declaration", i);
      i = j + 1;
      continue;
    }
    if (text.startsWith("</", i)) {
      let j = i + 2;
      while (j < n && WHITESPACE.test(text[j])) j++;
      const start = j;
      while (j < n && NAME_CHAR.test(text[j])) j++;
      const rawName = text.slice(start, j);
      while (j < n && WHITESPACE.test(text[j])) j++;
      if (text[j] !== ">") fail(`Malformed closing tag </${rawName}`, i);
      const name = keepNs ? rawName : stripPrefix(rawName);
      if (stack.length === 1) fail(`Closing tag </${rawName}> with no open element`, i);
      const open = stack[stack.length - 1];
      if (open.name !== name) fail(`Closing tag </${rawName}> does not match open <${open.name}>`, i);
      stack.pop();
      i = j + 1;
      continue;
    }

    // An opening or self-closing tag.
    let j = i + 1;
    if (j >= n || !NAME_START.test(text[j])) fail("Expected an element name after <", i);
    const nameStart = j;
    while (j < n && NAME_CHAR.test(text[j])) j++;
    const rawName = text.slice(nameStart, j);
    const element: XmlElement = { name: keepNs ? rawName : stripPrefix(rawName), attributes: {}, children: [] };

    let selfClosing = false;
    for (;;) {
      while (j < n && WHITESPACE.test(text[j])) j++;
      if (j >= n) fail(`Unterminated tag <${rawName}`, i);
      if (text[j] === ">") {
        j++;
        break;
      }
      if (text[j] === "/") {
        if (text[j + 1] !== ">") fail(`Malformed tag <${rawName}`, i);
        selfClosing = true;
        j += 2;
        break;
      }
      if (!NAME_START.test(text[j])) fail(`Malformed attribute in <${rawName}>`, i);
      const attrStart = j;
      while (j < n && NAME_CHAR.test(text[j])) j++;
      const attrName = text.slice(attrStart, j);
      while (j < n && WHITESPACE.test(text[j])) j++;
      if (text[j] !== "=") fail(`Attribute "${attrName}" in <${rawName}> has no value`, i);
      j++;
      while (j < n && WHITESPACE.test(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") fail(`Attribute "${attrName}" in <${rawName}> is not quoted`, i);
      const close = text.indexOf(quote, j + 1);
      if (close === -1) fail(`Unterminated value for attribute "${attrName}" in <${rawName}>`, i);
      const value = decodeXmlEntities(text.slice(j + 1, close));
      j = close + 1;
      if (!keepNs && (attrName === "xmlns" || attrName.startsWith("xmlns:"))) continue;
      element.attributes[keepNs ? attrName : stripPrefix(attrName)] = value;
    }

    const parent = stack[stack.length - 1];
    if (parent === root && root.children.some((c) => typeof c !== "string")) {
      fail(`A second root element <${rawName}>; a document has exactly one`, i);
    }
    parent.children.push(element);
    if (!selfClosing) stack.push(element);
    i = j;
  }

  if (stack.length > 1) {
    fail(`Unclosed element <${stack[stack.length - 1].name}>`, n);
  }
  const documentRoot = root.children.find((c): c is XmlElement => typeof c !== "string");
  if (!documentRoot) throw new FeedError("xml", "No root element found");
  return documentRoot;

  function appendText(parent: XmlElement, chunk: string, atTopLevel: boolean, at: number): void {
    if (atTopLevel) {
      if (chunk.trim() !== "") fail("Text outside the root element", at);
      return;
    }
    parent.children.push(decodeXmlEntities(chunk));
  }
}

/** The element children of an element, in order. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child !== "string" && (name === undefined || child.name === name)) out.push(child);
  }
  return out;
}

/** The first child element with the given name. */
export function childElement(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (typeof child !== "string" && child.name === name) return child;
  }
  return undefined;
}

/** The concatenated text of an element and everything inside it, trimmed. */
export function textOf(element: XmlElement | undefined): string {
  if (!element) return "";
  let out = "";
  for (const child of element.children) out += typeof child === "string" ? child : textOf(child);
  return out.trim();
}

/**
 * Elements matched by a slash-separated path — `listings/listing`,
 * `rss/channel/item`, or a `*` for any name. The first step names the root;
 * `//name` matches that name at any depth. Deliberately not XPath: a feed
 * has one shape and the path says it.
 */
export function selectElements(root: XmlElement, selector: string): XmlElement[] {
  const path = selector.trim();
  if (path === "") throw new FeedError("xml", "Empty selector");
  const anywhere = path.startsWith("//");
  const steps = (anywhere ? path.slice(2) : path.replace(/^\//, "")).split("/").map((s) => s.trim());
  if (steps.some((s) => s === "")) throw new FeedError("xml", `Malformed selector "${selector}"`);

  let current: XmlElement[];
  if (anywhere) {
    current = [];
    const walk = (el: XmlElement): void => {
      if (steps[0] === "*" || el.name === steps[0]) current.push(el);
      for (const child of childElements(el)) walk(child);
    };
    walk(root);
  } else {
    current = steps[0] === "*" || root.name === steps[0] ? [root] : [];
  }
  for (const step of steps.slice(1)) {
    const next: XmlElement[] = [];
    for (const el of current) next.push(...childElements(el, step === "*" ? undefined : step));
    current = next;
  }
  return current;
}

/** Options for {@link xmlToText}, {@link xmlSource} and {@link xmlItems}. */
export interface XmlSourceOptions extends XmlParseOptions {
  /**
   * Convert text values that contain markup — a description held in
   * CDATA as HTML — to plain text with `@sembl/source-html`. Default true.
   */
  html?: boolean;
  /** Deepest level to expand; deeper elements are rendered on one line. Default 24. */
  maxDepth?: number;
}

const LOOKS_LIKE_HTML = /<\/?[a-z][^>]*>|&(?:amp|lt|gt|nbsp|#\d+);/i;

function textValue(raw: string, html: boolean): string {
  const text = html && LOOKS_LIKE_HTML.test(raw) ? htmlToText(raw) : raw;
  return tidyText(text);
}

function pushElement(lines: OutlineLine[], depth: number, element: XmlElement, opts: Required<Pick<XmlSourceOptions, "html" | "maxDepth">>): void {
  const attrs = Object.entries(element.attributes);
  const children = element.children;
  const elements = childElements(element);
  const text = textValue(children.filter((c): c is string => typeof c === "string").join(""), opts.html);

  if (elements.length === 0) {
    // A leaf: `name: text`, attributes indented beneath it.
    if (text) pushScalar(lines, depth, element.name, text);
    else lines.push({ depth, text: `${element.name}:${attrs.length === 0 ? " (empty)" : ""}` });
    for (const [k, v] of attrs) pushScalar(lines, depth + 1, `@${k}`, tidyText(v));
    return;
  }

  if (depth >= opts.maxDepth) {
    lines.push({ depth, text: `${element.name}: ${tidyText(textOf(element)).replace(/\n+/g, " ")}` });
    return;
  }

  lines.push({ depth, text: `${element.name}:` });
  for (const [k, v] of attrs) pushScalar(lines, depth + 1, `@${k}`, tidyText(v));
  for (const child of children) {
    if (typeof child === "string") {
      const chunk = textValue(child, opts.html);
      if (chunk) for (const line of chunk.split("\n")) lines.push({ depth: depth + 1, text: line });
    } else {
      pushElement(lines, depth + 1, child, opts);
    }
  }
}

/** Render a parsed element as an outline; see {@link xmlToText}. */
export function elementToText(element: XmlElement, options: XmlSourceOptions = {}): string {
  const lines: OutlineLine[] = [];
  pushElement(lines, 0, element, { html: options.html ?? true, maxDepth: options.maxDepth ?? 24 });
  return renderOutline(lines);
}

/**
 * Render a document as an indented outline: each element as `name: text`
 * or `name:` with its children beneath, attributes as `@name: value`,
 * namespaces stripped, CDATA and entities decoded, HTML inside text
 * converted to plain text. Repeated elements repeat, which is how a model
 * best sees that a listing has three photos.
 */
export function xmlToText(xml: string, options: XmlSourceOptions = {}): string {
  return elementToText(parseXml(xml, options), options);
}

/** A whole document as one labelled SEMBL source. */
export function xmlSource(xml: string, label?: string, options?: XmlSourceOptions): Source {
  const text = xmlToText(xml, options);
  return label ? { label, text } : { text };
}

/**
 * One source per element the selector matches — `xmlItems(feed,
 * "listings/listing", "Listing")` — for `coerceMany`. Labels are numbered
 * from 1; the default label is the last step of the selector. Throws when
 * nothing matches, since a batch of nothing is almost always a wrong path.
 */
export function xmlItems(xml: string, selector: string, label?: string, options?: XmlSourceOptions): Source[] {
  const root = parseXml(xml, options);
  const matches = selectElements(root, selector);
  if (matches.length === 0) {
    throw new FeedError("xml", `Selector "${selector}" matched nothing under root <${root.name}>`);
  }
  const base = label ?? selector.split("/").filter(Boolean).pop() ?? "Item";
  return matches.map((el, i) => ({ label: itemLabel(base, i + 1), text: elementToText(el, options) }));
}
