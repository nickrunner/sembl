/**
 * WordprocessingML (`.docx`) to blocks.
 *
 * The package is read part by part: the main document, its relationships
 * (for images, notes, headers and footers), the style and numbering parts
 * (to tell headings and lists from plain paragraphs), the note parts, and
 * the core and app properties. Tracked changes are resolved to the final
 * text — insertions kept, deletions dropped — because that is what the
 * author of the document meant it to say.
 */
import type { Block, DocxMetadata, ParsedDocument, TableBlock, TableRow } from "./blocks.js";
import { noteMarker, parseCount, parseDate, renderBlocks, tidy } from "./blocks.js";
import { DocxError } from "./errors.js";
import { child, childElements, descend, findAll, parseXml, textOf, type XmlElement } from "./xml.js";
import type { ZipArchive } from "./zip.js";

export interface ParseOptions {
  headersFooters: boolean;
  footnotes: boolean;
}

interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

interface StyleInfo {
  heading?: { level: number; title?: boolean };
  numbering?: { numId: string; level: number };
}

interface Context {
  zip: ZipArchive;
  rels: Map<string, Relationship>;
  styles: Map<string, XmlElement>;
  styleCache: Map<string, StyleInfo>;
  numbering: Map<string, Map<number, string>>;
  footnotes: Map<string, XmlElement>;
  endnotes: Map<string, XmlElement>;
  includeNotes: boolean;
  markers: Map<string, number>;
  notes: Map<number, string>;
}

/** Elements whose content is never part of the final text. */
const SKIP = new Set([
  "w:del", "w:moveFrom", "w:delText", "w:delInstrText", "w:instrText", "w:pPr", "w:rPr", "w:tblPr",
  "w:tblGrid", "w:trPr", "w:tcPr", "w:sectPr", "w:footnoteRef", "w:endnoteRef", "w:separator",
  "w:continuationSeparator", "mc:Fallback", "w:fldChar", "w:commentRangeStart", "w:commentRangeEnd",
  "w:commentReference", "w:tblPrEx", "w:numPr",
]);

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Resolve a relationship target against the directory of its source part. */
function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base ? base.split("/") : [];
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

function readRelationships(zip: ZipArchive, relsPart: string, base: string): Map<string, Relationship> {
  const rels = new Map<string, Relationship>();
  const xml = zip.text(relsPart);
  if (!xml) return rels;
  for (const rel of findAll(parseXml(xml, relsPart), "rel:Relationship")) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target) continue;
    const external = rel.attrs.TargetMode === "External";
    rels.set(id, {
      type: (rel.attrs.Type ?? "").slice((rel.attrs.Type ?? "").lastIndexOf("/") + 1),
      target: external ? target : resolvePath(base, target),
      external,
    });
  }
  return rels;
}

function partOfType(rels: Map<string, Relationship>, type: string): string | undefined {
  for (const rel of rels.values()) {
    if (rel.type === type && !rel.external) return rel.target;
  }
  return undefined;
}

function partsOfType(rels: Map<string, Relationship>, type: string): string[] {
  const out: string[] = [];
  for (const rel of rels.values()) {
    if (rel.type === type && !rel.external) out.push(rel.target);
  }
  return out.sort();
}

function readPart(zip: ZipArchive, part: string | undefined): XmlElement | undefined {
  if (!part) return undefined;
  const xml = zip.text(part);
  return xml === undefined ? undefined : parseXml(xml, part);
}

function val(element: XmlElement | undefined): string | undefined {
  return element?.attrs["w:val"];
}

/** Whether an on/off element is on: present with no value, or a truthy one. */
function isOn(element: XmlElement | undefined): boolean {
  if (!element) return false;
  const v = val(element);
  return v === undefined || v === "1" || v === "true" || v === "on";
}

function loadStyles(root: XmlElement | undefined): Map<string, XmlElement> {
  const styles = new Map<string, XmlElement>();
  if (!root) return styles;
  for (const style of childElements(root, "w:style")) {
    const id = style.attrs["w:styleId"];
    if (id) styles.set(id, style);
  }
  return styles;
}

/** Numbering definitions: numId → level → number format. */
function loadNumbering(root: XmlElement | undefined): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  if (!root) return out;
  const abstracts = new Map<string, Map<number, string>>();
  for (const abstract of childElements(root, "w:abstractNum")) {
    const levels = new Map<number, string>();
    for (const lvl of childElements(abstract, "w:lvl")) {
      const ilvl = parseInt(lvl.attrs["w:ilvl"] ?? "", 10);
      const format = val(child(lvl, "w:numFmt"));
      if (Number.isFinite(ilvl) && format) levels.set(ilvl, format);
    }
    const id = abstract.attrs["w:abstractNumId"];
    if (id) abstracts.set(id, levels);
  }
  for (const num of childElements(root, "w:num")) {
    const id = num.attrs["w:numId"];
    const abstractId = val(child(num, "w:abstractNumId"));
    if (!id || abstractId === undefined) continue;
    const levels = new Map(abstracts.get(abstractId) ?? []);
    for (const override of childElements(num, "w:lvlOverride")) {
      const ilvl = parseInt(override.attrs["w:ilvl"] ?? "", 10);
      const format = val(descend(override, "w:lvl", "w:numFmt"));
      if (Number.isFinite(ilvl) && format) levels.set(ilvl, format);
    }
    out.set(id, levels);
  }
  return out;
}

/** What a paragraph style says about heading level and list membership, following `basedOn`. */
function styleInfo(ctx: Context, styleId: string | undefined): StyleInfo {
  if (!styleId) return {};
  const cached = ctx.styleCache.get(styleId);
  if (cached) return cached;
  const info: StyleInfo = {};
  const seen = new Set<string>();
  let id: string | undefined = styleId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const style: XmlElement | undefined = ctx.styles.get(id);
    if (!style) break;
    const name = val(child(style, "w:name")) ?? "";
    if (!info.heading) {
      const byName = /^heading\s*([1-9])$/i.exec(name) ?? /^Heading([1-9])$/.exec(id);
      if (byName) info.heading = { level: Number(byName[1]) };
      else if (/^title$/i.test(name) || id === "Title") info.heading = { level: 1, title: true };
      else {
        const outline = parseInt(val(descend(style, "w:pPr", "w:outlineLvl")) ?? "", 10);
        if (Number.isFinite(outline) && outline >= 0 && outline <= 8) info.heading = { level: outline + 1 };
      }
    }
    if (!info.numbering) {
      const numPr = descend(style, "w:pPr", "w:numPr");
      const numId = val(child(numPr ?? style, "w:numId"));
      if (numPr && numId !== undefined && numId !== "0") {
        info.numbering = { numId, level: parseInt(val(child(numPr, "w:ilvl")) ?? "0", 10) || 0 };
      }
    }
    id = val(child(style, "w:basedOn"));
  }
  ctx.styleCache.set(styleId, info);
  return info;
}

function imageName(ctx: Context, drawing: XmlElement): string {
  const docPr = findAll(drawing, "wp:docPr")[0];
  const description = docPr?.attrs.descr?.trim();
  if (description) return description;
  const blip = findAll(drawing, "a:blip")[0];
  const rId = blip?.attrs["r:embed"] ?? blip?.attrs["r:link"];
  const target = rId ? ctx.rels.get(rId)?.target : undefined;
  if (target) return basename(target);
  return docPr?.attrs.name?.trim() || "image";
}

function noteReference(ctx: Context, kind: "footnote" | "endnote", id: string | undefined): string {
  if (!ctx.includeNotes || id === undefined) return "";
  const key = `${kind}:${id}`;
  let marker = ctx.markers.get(key);
  if (marker === undefined) {
    const note = (kind === "footnote" ? ctx.footnotes : ctx.endnotes).get(id);
    if (!note) return "";
    marker = ctx.markers.size + 1;
    ctx.markers.set(key, marker);
    const blocks: Block[] = [];
    collectBlocks(ctx, note, blocks);
    ctx.notes.set(marker, renderBlocks(blocks).replace(/\s*\n\s*/g, " "));
  }
  return noteMarker(marker);
}

/** The text of the runs under an element, tracked changes resolved, images and notes marked. */
function inlineText(ctx: Context, element: XmlElement): string {
  let text = "";
  for (const node of element.children) {
    if (typeof node === "string") continue;
    if (SKIP.has(node.name)) continue;
    switch (node.name) {
      case "w:t":
        text += textOf(node);
        break;
      case "w:tab":
      case "w:ptab":
        text += "\t";
        break;
      case "w:br": {
        const type = node.attrs["w:type"];
        text += type === "page" || type === "column" ? "" : "\n";
        break;
      }
      case "w:cr":
        text += "\n";
        break;
      case "w:noBreakHyphen":
        text += "-";
        break;
      case "w:softHyphen":
      case "w:sym":
      case "w:lastRenderedPageBreak":
        break;
      case "w:footnoteReference":
        text += noteReference(ctx, "footnote", node.attrs["w:id"]);
        break;
      case "w:endnoteReference":
        text += noteReference(ctx, "endnote", node.attrs["w:id"]);
        break;
      case "w:drawing":
      case "w:pict":
      case "w:object": {
        const boxes = findAll(node, "w:txbxContent");
        if (boxes.length > 0) {
          const blocks: Block[] = [];
          for (const box of boxes) collectBlocks(ctx, box, blocks);
          const boxed = renderBlocks(blocks);
          if (boxed) text += `\n${boxed}\n`;
        } else if (node.name === "w:drawing") {
          text += `[image: ${imageName(ctx, node)}]`;
        } else {
          const data = findAll(node, "v:imagedata")[0];
          const rId = data?.attrs["r:id"] ?? data?.attrs["r:href"];
          const target = rId ? ctx.rels.get(rId)?.target : undefined;
          const title = data?.attrs["o:title"]?.trim();
          if (target || title) text += `[image: ${title || basename(target!)}]`;
        }
        break;
      }
      case "mc:AlternateContent": {
        const choice = child(node, "mc:Choice");
        if (choice) text += inlineText(ctx, choice);
        break;
      }
      case "w:ruby": {
        const base = child(node, "w:rubyBase");
        if (base) text += inlineText(ctx, base);
        break;
      }
      default:
        // Runs, hyperlinks, insertions, fields, content controls, smart tags:
        // containers whose text is in the leaves.
        text += inlineText(ctx, node);
    }
  }
  return text;
}

function paragraphBlock(ctx: Context, p: XmlElement): Block | undefined {
  const text = tidy(inlineText(ctx, p));
  if (!text) return undefined;
  const props = child(p, "w:pPr");
  const style = styleInfo(ctx, val(props && child(props, "w:pStyle")));

  const outline = parseInt(val(props && child(props, "w:outlineLvl")) ?? "", 10);
  const heading = Number.isFinite(outline)
    ? outline >= 0 && outline <= 8 ? { level: outline + 1 } : undefined
    : style.heading;
  if (heading) return { kind: "heading", level: heading.level, text, ...(heading.title ? { title: true } : {}) };

  const numPr = props && child(props, "w:numPr");
  const numId = val(numPr && child(numPr, "w:numId"));
  const numbering = numPr && numId !== undefined
    ? numId === "0" ? undefined : { numId, level: parseInt(val(child(numPr, "w:ilvl")) ?? "0", 10) || 0 }
    : style.numbering;
  if (numbering) {
    const format = ctx.numbering.get(numbering.numId)?.get(numbering.level);
    return { kind: "list-item", level: numbering.level, ordered: format !== undefined && format !== "bullet" && format !== "none", text };
  }
  return { kind: "paragraph", text };
}

/** Rows or cells reached through content controls and custom XML wrappers, but not through nested tables. */
function tableParts(element: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const node of element.children) {
    if (typeof node === "string" || SKIP.has(node.name)) continue;
    if (node.name === name) out.push(node);
    else if (node.name !== "w:tbl" && node.name !== "w:p") tableParts(node, name, out);
  }
  return out;
}

function cellText(ctx: Context, cell: XmlElement): string {
  const blocks: Block[] = [];
  collectBlocks(ctx, cell, blocks);
  return blocks
    .map((block) => {
      if (block.kind === "table") return block.rows.map((row) => row.cells.join(" | ")).join(" / ");
      if (block.kind === "list-item") return `- ${block.text}`;
      return block.text;
    })
    .filter(Boolean)
    .join(" / ");
}

function tableBlock(ctx: Context, tbl: XmlElement): TableBlock {
  const rows: TableRow[] = [];
  for (const tr of tableParts(tbl, "w:tr")) {
    const props = child(tr, "w:trPr");
    const header = isOn(props && child(props, "w:tblHeader"));
    const cells: string[] = [];
    for (const tc of tableParts(tr, "w:tc")) {
      const tcPr = child(tc, "w:tcPr");
      const span = Math.max(1, parseInt(val(tcPr && child(tcPr, "w:gridSpan")) ?? "1", 10) || 1);
      const vMerge = tcPr && child(tcPr, "w:vMerge");
      const continued = vMerge !== undefined && (val(vMerge) === undefined || val(vMerge) === "continue");
      cells.push(continued ? "" : cellText(ctx, tc));
      for (let i = 1; i < span; i++) cells.push("");
    }
    rows.push({ cells, header });
  }
  return { kind: "table", rows };
}

/** Whether a content control is a table of contents, whose entries would duplicate the headings. */
function isTableOfContents(sdt: XmlElement): boolean {
  const gallery = val(descend(sdt, "w:sdtPr", "w:docPartObj", "w:docPartGallery"));
  return gallery !== undefined && /table of contents/i.test(gallery);
}

/** Walk block-level content — paragraphs and tables, however wrapped — into blocks. */
function collectBlocks(ctx: Context, container: XmlElement, out: Block[]): void {
  for (const node of container.children) {
    if (typeof node === "string" || SKIP.has(node.name)) continue;
    if (node.name === "w:p") {
      const block = paragraphBlock(ctx, node);
      if (block) out.push(block);
    } else if (node.name === "w:tbl") {
      out.push(tableBlock(ctx, node));
    } else if (node.name === "w:sdt") {
      if (!isTableOfContents(node)) collectBlocks(ctx, node, out);
    } else if (node.name === "mc:AlternateContent") {
      const choice = child(node, "mc:Choice");
      if (choice) collectBlocks(ctx, choice, out);
    } else {
      collectBlocks(ctx, node, out);
    }
  }
}

function loadNotes(root: XmlElement | undefined, name: string): Map<string, XmlElement> {
  const notes = new Map<string, XmlElement>();
  if (!root) return notes;
  for (const note of childElements(root, name)) {
    const type = note.attrs["w:type"];
    const id = note.attrs["w:id"];
    if (id !== undefined && type !== "separator" && type !== "continuationSeparator") notes.set(id, note);
  }
  return notes;
}

function readMetadata(zip: ZipArchive, packageRels: Map<string, Relationship>): DocxMetadata {
  const metadata: DocxMetadata = {};
  const core = readPart(zip, partOfType(packageRels, "core-properties") ?? (zip.has("docProps/core.xml") ? "docProps/core.xml" : undefined));
  if (core) {
    const text = (name: string) => {
      const value = child(core, name);
      return value ? tidy(textOf(value)).replace(/\n/g, " ") : undefined;
    };
    const title = text("dc:title");
    const author = text("dc:creator");
    const created = parseDate(text("dcterms:created"));
    const modified = parseDate(text("dcterms:modified"));
    if (title) metadata.title = title;
    if (author) metadata.author = author;
    if (created) metadata.created = created;
    if (modified) metadata.modified = modified;
  }
  const app = readPart(zip, partOfType(packageRels, "extended-properties") ?? (zip.has("docProps/app.xml") ? "docProps/app.xml" : undefined));
  if (app) {
    const words = child(app, "ep:Words");
    const count = parseCount(words && textOf(words));
    if (count !== undefined) metadata.wordCount = count;
  }
  return metadata;
}

/** Where the main document part lives, per the package relationships. */
export function mainPart(zip: ZipArchive): string | undefined {
  const packageRels = readRelationships(zip, "_rels/.rels", "");
  const part = partOfType(packageRels, "officeDocument");
  if (part && zip.has(part)) return part;
  return zip.has("word/document.xml") ? "word/document.xml" : undefined;
}

/** Only the metadata, without walking the body. */
export function docxMetadata(zip: ZipArchive): DocxMetadata {
  return readMetadata(zip, readRelationships(zip, "_rels/.rels", ""));
}

export function parseDocx(zip: ZipArchive, options: ParseOptions): ParsedDocument {
  const part = mainPart(zip);
  if (!part) throw new DocxError("malformed", "Not a Word document: the package has no main document part.");
  const base = dirname(part);
  const rels = readRelationships(zip, `${base}/_rels/${basename(part)}.rels`, base);
  const document = readPart(zip, part)!;
  const body = child(document, "w:body");
  if (!body) throw new DocxError("malformed", `The document part "${part}" has no <w:body>.`);

  const ctx: Context = {
    zip,
    rels,
    styles: loadStyles(readPart(zip, partOfType(rels, "styles") ?? `${base}/styles.xml`)),
    styleCache: new Map(),
    numbering: loadNumbering(readPart(zip, partOfType(rels, "numbering") ?? `${base}/numbering.xml`)),
    footnotes: loadNotes(readPart(zip, partOfType(rels, "footnotes") ?? `${base}/footnotes.xml`), "w:footnote"),
    endnotes: loadNotes(readPart(zip, partOfType(rels, "endnotes") ?? `${base}/endnotes.xml`), "w:endnote"),
    includeNotes: options.footnotes,
    markers: new Map(),
    notes: new Map(),
  };

  const blocks: Block[] = [];
  collectBlocks(ctx, body, blocks);

  const marginalia = (type: string): string[] => {
    if (!options.headersFooters) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const target of partsOfType(rels, type)) {
      const root = readPart(zip, target);
      if (!root) continue;
      const inner: Block[] = [];
      collectBlocks(ctx, root, inner);
      const text = renderBlocks(inner);
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    return out;
  };

  return {
    blocks,
    notes: ctx.notes,
    headers: marginalia("header"),
    footers: marginalia("footer"),
    metadata: readMetadata(zip, readRelationships(zip, "_rels/.rels", "")),
  };
}
