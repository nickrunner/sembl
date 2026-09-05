/**
 * OpenDocument Text (`.odt`) to blocks.
 *
 * The same model as `.docx`, read from `content.xml`: `text:h` carries its
 * outline level, lists nest as `text:list` elements, tables mark their
 * header rows, notes sit inline with their body. Tracked changes in ODF
 * keep the deleted text in a separate region, so the content is already
 * the final text.
 */
import type { Block, DocxMetadata, ParsedDocument, TableRow } from "./blocks.js";
import { noteMarker, parseCount, parseDate, renderBlocks, tidy } from "./blocks.js";
import { DocxError } from "./errors.js";
import type { ParseOptions } from "./docx.js";
import { child, childElements, descend, findAll, parseXml, textOf, type XmlElement } from "./xml.js";
import type { ZipArchive } from "./zip.js";

interface Context {
  /** Paragraph style name → parent style name. */
  parents: Map<string, string>;
  /** Paragraph style name → default outline level, when a style declares one. */
  outline: Map<string, number>;
  /** List style name → level (1-based) → whether numbered. */
  listStyles: Map<string, Map<number, boolean>>;
  includeNotes: boolean;
  notes: Map<number, string>;
}

const SKIP = new Set([
  "text:tracked-changes", "text:sequence-decls", "office:forms", "text:table-of-content",
  "text:alphabetical-index", "text:illustration-index", "text:table-index", "text:object-index",
  "text:user-index", "text:bibliography", "office:annotation", "office:annotation-end",
  "text:note-citation", "text:change", "text:change-start", "text:change-end", "text:soft-page-break",
  "text:bookmark", "text:bookmark-start", "text:bookmark-end", "text:reference-mark",
  "text:reference-mark-start", "text:reference-mark-end", "table:table-column", "table:table-columns",
  "table:table-header-columns", "table:table-column-group", "office:binary-data", "svg:title", "svg:desc",
]);

function loadStyles(ctx: Context, root: XmlElement | undefined): void {
  if (!root) return;
  for (const container of ["office:styles", "office:automatic-styles"]) {
    const group = child(root, container);
    if (!group) continue;
    for (const style of childElements(group, "style:style")) {
      const name = style.attrs["style:name"];
      if (!name || style.attrs["style:family"] !== "paragraph") continue;
      const parent = style.attrs["style:parent-style-name"];
      if (parent) ctx.parents.set(name, parent);
      const level = parseInt(style.attrs["style:default-outline-level"] ?? "", 10);
      if (Number.isFinite(level) && level >= 1) ctx.outline.set(name, level);
    }
    for (const list of childElements(group, "text:list-style")) {
      const name = list.attrs["style:name"];
      if (!name) continue;
      const levels = new Map<number, boolean>();
      for (const level of childElements(list)) {
        const n = parseInt(level.attrs["text:level"] ?? "", 10);
        if (Number.isFinite(n)) levels.set(n, level.name === "text:list-level-style-number");
      }
      ctx.listStyles.set(name, levels);
    }
  }
}

/** The named style and its ancestors, nearest first. */
function styleChain(ctx: Context, name: string | undefined): string[] {
  const chain: string[] = [];
  let current = name;
  while (current && !chain.includes(current) && chain.length < 16) {
    chain.push(current);
    current = ctx.parents.get(current);
  }
  return chain;
}

function noteText(ctx: Context, note: XmlElement): string {
  const body = child(note, "text:note-body");
  if (!body) return "";
  const blocks: Block[] = [];
  collectBlocks(ctx, body, blocks, 0, undefined);
  return renderBlocks(blocks).replace(/\s*\n\s*/g, " ");
}

function imageName(frame: XmlElement): string {
  const described = child(frame, "svg:desc") ?? child(frame, "svg:title");
  const description = described ? tidy(textOf(described)).replace(/\n/g, " ") : "";
  if (description) return description;
  const image = child(frame, "draw:image");
  const href = image?.attrs["xlink:href"];
  if (href) return href.slice(href.lastIndexOf("/") + 1);
  return frame.attrs["draw:name"]?.trim() || "image";
}

function inlineText(ctx: Context, element: XmlElement): string {
  let text = "";
  for (const node of element.children) {
    if (typeof node === "string") {
      text += node;
      continue;
    }
    if (SKIP.has(node.name)) continue;
    switch (node.name) {
      case "text:s": {
        const count = parseInt(node.attrs["text:c"] ?? "1", 10);
        text += " ".repeat(Number.isFinite(count) && count > 0 ? count : 1);
        break;
      }
      case "text:tab":
        text += "\t";
        break;
      case "text:line-break":
        text += "\n";
        break;
      case "text:note": {
        if (!ctx.includeNotes) break;
        const body = noteText(ctx, node);
        if (body) {
          const marker = ctx.notes.size + 1;
          ctx.notes.set(marker, body);
          text += noteMarker(marker);
        }
        break;
      }
      case "draw:frame": {
        const box = child(node, "draw:text-box");
        if (box) {
          const blocks: Block[] = [];
          collectBlocks(ctx, box, blocks, 0, undefined);
          const boxed = renderBlocks(blocks);
          if (boxed) text += `\n${boxed}\n`;
        } else if (child(node, "draw:image") || child(node, "draw:object")) {
          text += `[image: ${imageName(node)}]`;
        }
        break;
      }
      default:
        text += inlineText(ctx, node);
    }
  }
  return text;
}

interface ListState {
  level: number;
  ordered: boolean;
}

function paragraphBlock(ctx: Context, p: XmlElement, list: ListState | undefined): Block | undefined {
  const text = tidy(inlineText(ctx, p));
  if (!text) return undefined;
  if (p.name === "text:h") {
    const level = parseInt(p.attrs["text:outline-level"] ?? "1", 10);
    return { kind: "heading", level: Number.isFinite(level) && level >= 1 ? level : 1, text };
  }
  const chain = styleChain(ctx, p.attrs["text:style-name"]);
  if (chain.some((name) => name === "Title")) return { kind: "heading", level: 1, text, title: true };
  if (list) return { kind: "list-item", level: list.level, ordered: list.ordered, text };
  for (const name of chain) {
    const level = ctx.outline.get(name);
    if (level !== undefined) return { kind: "heading", level, text };
  }
  return { kind: "paragraph", text };
}

function cellText(ctx: Context, cell: XmlElement): string {
  const blocks: Block[] = [];
  collectBlocks(ctx, cell, blocks, 0, undefined);
  return blocks
    .map((block) => {
      if (block.kind === "table") return block.rows.map((row) => row.cells.join(" | ")).join(" / ");
      if (block.kind === "list-item") return `- ${block.text}`;
      return block.text;
    })
    .filter(Boolean)
    .join(" / ");
}

function tableRows(ctx: Context, container: XmlElement, header: boolean, rows: TableRow[]): void {
  for (const node of childElements(container)) {
    if (node.name === "table:table-row") {
      const cells: string[] = [];
      for (const cell of childElements(node)) {
        if (cell.name === "table:covered-table-cell") cells.push("");
        else if (cell.name === "table:table-cell") {
          // Spanned columns are followed by covered cells, so no padding is needed.
          cells.push(cellText(ctx, cell));
        }
      }
      rows.push({ cells, header });
    } else if (node.name === "table:table-header-rows") {
      tableRows(ctx, node, true, rows);
    } else if (node.name === "table:table-rows" || node.name === "table:table-row-group") {
      tableRows(ctx, node, header, rows);
    }
  }
}

function listBlocks(ctx: Context, list: XmlElement, depth: number, styleName: string | undefined, out: Block[]): void {
  const style = list.attrs["text:style-name"] ?? styleName;
  const ordered = ctx.listStyles.get(style ?? "")?.get(depth + 1) ?? false;
  for (const item of childElements(list)) {
    if (item.name !== "text:list-item" && item.name !== "text:list-header") continue;
    collectBlocks(ctx, item, out, depth, { level: depth, ordered }, style);
  }
}

function collectBlocks(
  ctx: Context,
  container: XmlElement,
  out: Block[],
  depth: number,
  list: ListState | undefined,
  listStyle?: string,
): void {
  for (const node of container.children) {
    if (typeof node === "string" || SKIP.has(node.name)) continue;
    if (node.name === "text:p" || node.name === "text:h") {
      const block = paragraphBlock(ctx, node, list);
      if (block) out.push(block);
    } else if (node.name === "text:list") {
      listBlocks(ctx, node, list ? depth + 1 : 0, listStyle, out);
    } else if (node.name === "table:table") {
      const rows: TableRow[] = [];
      tableRows(ctx, node, false, rows);
      out.push({ kind: "table", rows });
    } else {
      collectBlocks(ctx, node, out, depth, list, listStyle);
    }
  }
}

function readMetadata(zip: ZipArchive): DocxMetadata {
  const metadata: DocxMetadata = {};
  const xml = zip.text("meta.xml");
  if (!xml) return metadata;
  const meta = child(parseXml(xml, "meta.xml"), "office:meta");
  if (!meta) return metadata;
  const text = (name: string) => {
    const value = child(meta, name);
    return value ? tidy(textOf(value)).replace(/\n/g, " ") : undefined;
  };
  const title = text("dc:title");
  const author = text("meta:initial-creator") ?? text("dc:creator");
  const created = parseDate(text("meta:creation-date"));
  const modified = parseDate(text("dc:date"));
  const words = parseCount(child(meta, "meta:document-statistic")?.attrs["meta:word-count"]);
  if (title) metadata.title = title;
  if (author) metadata.author = author;
  if (created) metadata.created = created;
  if (modified) metadata.modified = modified;
  if (words !== undefined) metadata.wordCount = words;
  return metadata;
}

/** Whether the archive is an OpenDocument package, and of what kind. */
export function odtMimeType(zip: ZipArchive): string | undefined {
  const declared = zip.text("mimetype")?.trim();
  if (declared) return declared;
  return zip.has("content.xml") ? "application/vnd.oasis.opendocument.text" : undefined;
}

function checkEncryption(zip: ZipArchive): void {
  const manifest = zip.text("META-INF/manifest.xml");
  if (manifest && manifest.includes("encryption-data")) {
    throw new DocxError("encrypted", "This OpenDocument file is password-protected; remove the password and try again.");
  }
}

export function odtMetadata(zip: ZipArchive): DocxMetadata {
  checkEncryption(zip);
  return readMetadata(zip);
}

export function parseOdt(zip: ZipArchive, options: ParseOptions): ParsedDocument {
  checkEncryption(zip);
  const content = zip.text("content.xml");
  if (content === undefined) throw new DocxError("malformed", "Not an OpenDocument file: the package has no content.xml.");
  const root = parseXml(content, "content.xml");
  const body = descend(root, "office:body", "office:text");
  if (!body) throw new DocxError("malformed", "content.xml has no <office:text> body.");

  const ctx: Context = {
    parents: new Map(),
    outline: new Map(),
    listStyles: new Map(),
    includeNotes: options.footnotes,
    notes: new Map(),
  };
  const stylesXml = zip.text("styles.xml");
  const styles = stylesXml === undefined ? undefined : parseXml(stylesXml, "styles.xml");
  loadStyles(ctx, styles);
  loadStyles(ctx, root);

  const blocks: Block[] = [];
  collectBlocks(ctx, body, blocks, 0, undefined);

  const marginalia = (name: string): string[] => {
    if (!options.headersFooters || !styles) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const page of findAll(styles, "style:master-page")) {
      for (const region of childElements(page, name)) {
        const inner: Block[] = [];
        collectBlocks(ctx, region, inner, 0, undefined);
        const text = renderBlocks(inner);
        if (text && !seen.has(text)) {
          seen.add(text);
          out.push(text);
        }
      }
    }
    return out;
  };

  return {
    blocks,
    notes: ctx.notes,
    headers: marginalia("style:header"),
    footers: marginalia("style:footer"),
    metadata: readMetadata(zip),
  };
}
