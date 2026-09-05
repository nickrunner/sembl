import { readFile } from "node:fs/promises";
import type { Source } from "@sembl/core";
import type { Block, DocxMetadata, HeadingBlock, ParsedDocument, TableStyle } from "./blocks.js";
import { referencedNotes, renderBlocks, renderMetadata, renderNotes } from "./blocks.js";
import { docxMetadata, mainPart, parseDocx } from "./docx.js";
import { DocxError } from "./errors.js";
import { odtMetadata, odtMimeType, parseOdt } from "./odt.js";
import { openZip, type ZipArchive } from "./zip.js";

export { DocxError } from "./errors.js";
export type { DocxErrorCode } from "./errors.js";
export type { DocxMetadata, TableStyle } from "./blocks.js";

/** Options for {@link docxToText}, {@link docxSource} and {@link docxSources}. */
export interface DocxTextOptions {
  /** Include the page headers and footers. Default false: they are chrome, not content. */
  headersFooters?: boolean;
  /** Mark footnote and endnote references in the text and append the notes. Default true. */
  footnotes?: boolean;
  /**
   * How tables are rendered. `"pipes"` (default) gives Markdown-style rows
   * with a separator under the header row; `"lines"` puts each cell on its
   * own line with a blank line between rows, for tables that are really
   * paragraphs in a grid.
   */
  tables?: TableStyle;
  /** Include the document's core properties ahead of the text. Default true. */
  metadata?: boolean;
}

/** Bytes of a document, however they were read. */
export type DocxInput = Uint8Array | ArrayBuffer;

const ODT_TEXT = "application/vnd.oasis.opendocument.text";

function open(data: DocxInput): { zip: ZipArchive; kind: "docx" | "odt" } {
  const zip = openZip(data);
  if (mainPart(zip)) return { zip, kind: "docx" };
  const mime = odtMimeType(zip);
  if (mime === ODT_TEXT || mime === `${ODT_TEXT}-template`) return { zip, kind: "odt" };
  if (mime?.startsWith("application/vnd.oasis.opendocument.")) {
    throw new DocxError("unsupported", `This is an OpenDocument file of type ${mime}; only text documents (.odt) are supported.`);
  }
  if (zip.has("xl/workbook.xml") || zip.has("ppt/presentation.xml")) {
    throw new DocxError("unsupported", "This is an Office spreadsheet or presentation, not a Word document.");
  }
  throw new DocxError("not-a-document", "Not a Word document: the zip archive has no word/document.xml or content.xml.");
}

function parse(data: DocxInput, options: DocxTextOptions): ParsedDocument {
  const { zip, kind } = open(data);
  const parseOptions = { headersFooters: options.headersFooters ?? false, footnotes: options.footnotes ?? true };
  return kind === "docx" ? parseDocx(zip, parseOptions) : parseOdt(zip, parseOptions);
}

/** Render one run of blocks with the notes they reference, and any marginalia. */
function renderPart(
  document: ParsedDocument,
  blocks: readonly Block[],
  options: DocxTextOptions,
  edges: { headers?: boolean; footers?: boolean },
): string {
  const parts: string[] = [];
  if (edges.headers && document.headers.length > 0) parts.push(`Header:\n${document.headers.join("\n")}`);
  const text = renderBlocks(blocks, options.tables ?? "pipes");
  if (text) parts.push(text);
  if (options.footnotes ?? true) {
    const notes = renderNotes(referencedNotes(blocks, document.notes));
    if (notes) parts.push(notes);
  }
  if (edges.footers && document.footers.length > 0) parts.push(`Footer:\n${document.footers.join("\n")}`);
  return parts.join("\n\n");
}

function renderDocument(document: ParsedDocument, options: DocxTextOptions): string {
  const sections: string[] = [];
  if (options.metadata ?? true) {
    const metadata = renderMetadata(document.metadata);
    if (metadata) sections.push(metadata);
  }
  const body = renderPart(document, document.blocks, options, { headers: true, footers: true });
  if (body) sections.push(`Document text:\n${body}`);
  return sections.join("\n\n");
}

/**
 * Render a Word document as text for extraction: headings as `#` lines,
 * list items as `- ` (or `1. `) lines indented by nesting, tables as
 * pipe-delimited rows with a separator under the header row, images as
 * `[image: name]`, footnotes marked `[^n]` and listed at the end. Bold,
 * italic and every other formatting choice is dropped; tracked changes are
 * resolved to the final text.
 *
 * The core properties — title, author, dates, word count — come first, in
 * the same shape as `@sembl/source-html`'s metadata section, so SEMBL's
 * head-keeping truncation preserves them on a long document.
 *
 * Accepts `.docx` and `.odt`. Throws {@link DocxError} for anything else,
 * including password-protected files.
 */
export async function docxToText(data: DocxInput, options: DocxTextOptions = {}): Promise<string> {
  return renderDocument(parse(data, options), options);
}

/**
 * The document's core properties: title, author, created and modified
 * dates, and the word count the writing application recorded. Only the
 * properties the document actually has are present.
 */
export async function extractDocxMetadata(data: DocxInput): Promise<DocxMetadata> {
  const { zip, kind } = open(data);
  return kind === "docx" ? docxMetadata(zip) : odtMetadata(zip);
}

/**
 * Build a labelled SEMBL source from a document, ready to pass to any
 * coercion or to `sembl()`. For a document that may blow the input budget,
 * prefer {@link docxSources}, which gives each top-level section its own
 * source so the budget trims the long ones first.
 */
export async function docxSource(data: DocxInput, label?: string, options: DocxTextOptions = {}): Promise<Source> {
  const text = await docxToText(data, options);
  return label ? { label, text } : { text };
}

/** A label that stays readable when a heading runs long. */
function sectionLabel(label: string, heading: HeadingBlock, used: Map<string, number>): string {
  const title = heading.text.replace(/\s+/g, " ").trim();
  const short = title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
  const base = `${label} — ${short}`;
  const count = (used.get(base) ?? 0) + 1;
  used.set(base, count);
  return count === 1 ? base : `${base} (${count})`;
}

/**
 * A document as one source per top-level section, each labelled with its
 * heading ("Handover notes — Access"), plus a leading source for the
 * metadata and anything before the first heading. SEMBL's budget cuts long
 * sources first, so a long document loses the tail of its longest
 * sections rather than everything after some point — and provenance can
 * say which section a value came from. A document with no headings comes
 * back as a single source.
 */
export async function docxSources(data: DocxInput, label = "Document", options: DocxTextOptions = {}): Promise<Source[]> {
  const document = parse(data, options);
  const levels = document.blocks.flatMap((block) => (block.kind === "heading" && !block.title ? [block.level] : []));
  if (levels.length === 0) {
    const text = renderDocument(document, options);
    return text ? [{ label, text }] : [];
  }

  const top = Math.min(...levels);
  const preamble: Block[] = [];
  const sections: { heading: HeadingBlock; blocks: Block[] }[] = [];
  for (const block of document.blocks) {
    if (block.kind === "heading" && !block.title && block.level === top) {
      sections.push({ heading: block, blocks: [block] });
    } else if (sections.length === 0) {
      preamble.push(block);
    } else {
      sections[sections.length - 1].blocks.push(block);
    }
  }

  const sources: Source[] = [];
  const lead: string[] = [];
  if (options.metadata ?? true) {
    const metadata = renderMetadata(document.metadata);
    if (metadata) lead.push(metadata);
  }
  const opening = renderPart(document, preamble, options, { headers: true });
  if (opening) lead.push(`Document text:\n${opening}`);
  if (lead.length > 0) sources.push({ label, text: lead.join("\n\n") });

  const used = new Map<string, number>();
  sections.forEach((section, i) => {
    const text = renderPart(document, section.blocks, options, { footers: i === sections.length - 1 });
    if (text) sources.push({ label: sectionLabel(label, section.heading, used), text });
  });
  return sources;
}

/** Read a document from disk. A convenience for the common case; the other functions take bytes. */
export async function readDocxFile(path: string): Promise<Uint8Array> {
  const buffer = await readFile(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
