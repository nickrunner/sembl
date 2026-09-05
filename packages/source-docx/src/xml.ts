/**
 * A small XML reader for the machine-written parts of an Office package.
 *
 * It builds a plain tree — elements with a name, attributes and children —
 * and resolves namespaces to fixed prefixes (`w:p`, `text:h`, …) so the
 * parsers can match on the names every Office suite uses, whatever prefix
 * a particular writer chose. It is not a general XML parser: no DTDs, no
 * entity definitions beyond the five built-in ones plus character
 * references. That is all Office XML ever contains.
 */
import { DocxError } from "./errors.js";

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

/** The namespaces the parsers match on, keyed by URI, valued by the prefix used in code. */
const NAMESPACES: Record<string, string> = {
  // WordprocessingML
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/package/2006/relationships": "rel",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape": "wps",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "urn:schemas-microsoft-com:vml": "v",
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties": "cp",
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties": "ep",
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://purl.org/dc/terms/": "dcterms",
  // OpenDocument
  "urn:oasis:names:tc:opendocument:xmlns:office:1.0": "office",
  "urn:oasis:names:tc:opendocument:xmlns:text:1.0": "text",
  "urn:oasis:names:tc:opendocument:xmlns:table:1.0": "table",
  "urn:oasis:names:tc:opendocument:xmlns:style:1.0": "style",
  "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0": "draw",
  "urn:oasis:names:tc:opendocument:xmlns:meta:1.0": "meta",
  "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0": "manifest",
  "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0": "svg",
  "http://www.w3.org/1999/xlink": "xlink",
  "http://www.w3.org/XML/1998/namespace": "xml",
};

const BUILT_IN_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the five built-in entities and character references. */
export function decodeXml(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return BUILT_IN_ENTITIES[ref] ?? match;
  });
}

const NAME_CHAR = /[^\s/>=]/;

/**
 * Parse a document into its root element. Throws {@link DocxError} with
 * code `malformed` when the markup is not well formed.
 */
export function parseXml(source: string, part = "document"): XmlElement {
  const malformed = (what: string): DocxError =>
    new DocxError("malformed", `The document part "${part}" is not well-formed XML: ${what}.`);

  // Namespace scopes: each open element pushes the prefix → URI map in force.
  const scopes: Record<string, string>[] = [{ xml: "http://www.w3.org/XML/1998/namespace" }];
  const canonical = (qualified: string, isAttribute: boolean): string => {
    const colon = qualified.indexOf(":");
    const prefix = colon === -1 ? "" : qualified.slice(0, colon);
    const local = colon === -1 ? qualified : qualified.slice(colon + 1);
    if (isAttribute && prefix === "") return local;
    const uri = scopes[scopes.length - 1][prefix];
    if (uri === undefined) return qualified;
    const known = NAMESPACES[uri];
    return known === undefined ? qualified : known ? `${known}:${local}` : local;
  };

  const root: XmlElement = { name: "", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const length = source.length;

  while (i < length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) {
      const tail = source.slice(i);
      if (tail.trim()) stack[stack.length - 1].children.push(decodeXml(tail));
      break;
    }
    if (lt > i) {
      stack[stack.length - 1].children.push(decodeXml(source.slice(i, lt)));
    }
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) throw malformed("unterminated comment");
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end === -1) throw malformed("unterminated CDATA section");
      stack[stack.length - 1].children.push(source.slice(i + 9, end));
      i = end + 3;
    } else if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end === -1) throw malformed("unterminated processing instruction");
      i = end + 2;
    } else if (source.startsWith("<!", i)) {
      const end = source.indexOf(">", i + 2);
      if (end === -1) throw malformed("unterminated declaration");
      i = end + 1;
    } else if (source.startsWith("</", i)) {
      const end = source.indexOf(">", i + 2);
      if (end === -1) throw malformed("unterminated end tag");
      const name = source.slice(i + 2, end).trim();
      const open = stack[stack.length - 1];
      if (stack.length === 1) throw malformed(`unexpected end tag </${name}>`);
      if (canonical(name, false) !== open.name) throw malformed(`end tag </${name}> does not match <${open.name}>`);
      stack.pop();
      scopes.pop();
      i = end + 1;
    } else {
      // Start tag: name, attributes, optional self-closing slash.
      let j = i + 1;
      while (j < length && NAME_CHAR.test(source[j])) j++;
      if (j === i + 1) throw malformed(`stray "<" at offset ${i}`);
      const rawName = source.slice(i + 1, j);
      const rawAttrs: [string, string][] = [];
      let selfClosing = false;
      for (;;) {
        while (j < length && /\s/.test(source[j])) j++;
        if (j >= length) throw malformed(`unterminated start tag <${rawName}>`);
        if (source[j] === ">") {
          j++;
          break;
        }
        if (source[j] === "/") {
          if (source[j + 1] !== ">") throw malformed(`bad "/" in start tag <${rawName}>`);
          selfClosing = true;
          j += 2;
          break;
        }
        let k = j;
        while (k < length && NAME_CHAR.test(source[k])) k++;
        const attrName = source.slice(j, k);
        if (!attrName) throw malformed(`bad attribute in <${rawName}>`);
        while (k < length && /\s/.test(source[k])) k++;
        if (source[k] !== "=") throw malformed(`attribute ${attrName} in <${rawName}> has no value`);
        k++;
        while (k < length && /\s/.test(source[k])) k++;
        const quote = source[k];
        if (quote !== '"' && quote !== "'") throw malformed(`attribute ${attrName} in <${rawName}> is not quoted`);
        const close = source.indexOf(quote, k + 1);
        if (close === -1) throw malformed(`unterminated attribute value in <${rawName}>`);
        rawAttrs.push([attrName, decodeXml(source.slice(k + 1, close))]);
        j = close + 1;
      }

      // Namespace declarations on this element come into force before its
      // own name and attributes are resolved.
      const parentScope = scopes[scopes.length - 1];
      let scope = parentScope;
      for (const [name, value] of rawAttrs) {
        if (name === "xmlns") {
          if (scope === parentScope) scope = { ...parentScope };
          scope[""] = value;
        } else if (name.startsWith("xmlns:")) {
          if (scope === parentScope) scope = { ...parentScope };
          scope[name.slice(6)] = value;
        }
      }
      scopes.push(scope);

      const element: XmlElement = { name: canonical(rawName, false), attrs: {}, children: [] };
      for (const [name, value] of rawAttrs) {
        if (name === "xmlns" || name.startsWith("xmlns:")) continue;
        element.attrs[canonical(name, true)] = value;
      }
      stack[stack.length - 1].children.push(element);
      if (selfClosing) {
        scopes.pop();
      } else {
        stack.push(element);
      }
      i = j;
    }
  }

  if (stack.length !== 1) throw malformed(`element <${stack[stack.length - 1].name}> is never closed`);
  const first = root.children.find((node): node is XmlElement => typeof node !== "string");
  if (!first) throw malformed("no root element");
  return first;
}

/** The direct child elements with a given name. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child !== "string" && (name === undefined || child.name === name)) out.push(child);
  }
  return out;
}

/** The first direct child element with a given name. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
  for (const node of element.children) {
    if (typeof node !== "string" && node.name === name) return node;
  }
  return undefined;
}

/** Follow a path of child names, returning the first match at each step. */
export function descend(element: XmlElement, ...path: string[]): XmlElement | undefined {
  let current: XmlElement | undefined = element;
  for (const name of path) {
    current = current && child(current, name);
  }
  return current;
}

/** Every descendant element with a given name, in document order. */
export function findAll(element: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const node of element.children) {
    if (typeof node === "string") continue;
    if (node.name === name) out.push(node);
    findAll(node, name, out);
  }
  return out;
}

/** All text under an element, concatenated. */
export function textOf(element: XmlElement): string {
  let text = "";
  for (const node of element.children) {
    text += typeof node === "string" ? node : textOf(node);
  }
  return text;
}
