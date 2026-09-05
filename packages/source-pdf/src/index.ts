import { readFile } from "node:fs/promises";
import type { Source } from "@sembl/core";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdfDate, withDocument } from "./pdfjs.js";
import type { PdfOpenOptions } from "./pdfjs.js";
import { itemsToText } from "./text-layout.js";

export { PdfError } from "./pdfjs.js";
export type { PdfErrorCode, PdfOpenOptions } from "./pdfjs.js";
export { itemsToText, runsToText, itemsToRuns } from "./text-layout.js";
export type { TextRun, PdfTextItem } from "./text-layout.js";

/** Which pages to read, 1-based. A list, or an inclusive range with open ends. */
export type PageSelection = number[] | { from?: number; to?: number };

/** Options for {@link pdfToText}, {@link pdfPages} and the source builders. */
export interface PdfTextOptions extends PdfOpenOptions {
  /** Pages to read, 1-based. Numbers outside the document are ignored. Default all. */
  pages?: PageSelection;
  /** Read at most this many of the selected pages, from the first. Default no cap. */
  maxPages?: number;
}

/** Options for {@link pdfSource} and {@link pdfSources}. */
export interface PdfSourceOptions extends PdfTextOptions {
  /** Include the document metadata ahead of the text. Default true. */
  meta?: boolean;
}

/** One page's text. */
export interface PdfPage {
  /** 1-based page number in the document. */
  number: number;
  /** The reconstructed text; empty for a page with no text layer. */
  text: string;
}

/** What the document says about itself, from its info dictionary or XMP. */
export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  created?: Date;
  modified?: Date;
  pageCount: number;
}

/** A quick look at a document before deciding how to read it. */
export interface PdfInfo {
  pageCount: number;
  /** Whether any page carries extractable text. False for a scan, which needs an image path instead. */
  hasText: boolean;
  /** How many pages carry text. */
  pagesWithText: number;
  /** Whether the document is encrypted (it opened, so the password given or the empty one worked). */
  encrypted: boolean;
  metadata: PdfMetadata;
}

/** The page numbers a selection means for a document of `pageCount` pages, in order. */
export function selectPages(pageCount: number, options: PdfTextOptions = {}): number[] {
  const { pages, maxPages } = options;
  let numbers: number[];
  if (Array.isArray(pages)) {
    numbers = [...new Set(pages)].filter((n) => Number.isInteger(n) && n >= 1 && n <= pageCount).sort((a, b) => a - b);
  } else {
    const from = Math.max(1, Math.floor(pages?.from ?? 1));
    const to = Math.min(pageCount, Math.floor(pages?.to ?? pageCount));
    numbers = [];
    for (let n = from; n <= to; n++) numbers.push(n);
  }
  if (maxPages !== undefined && maxPages >= 0) numbers = numbers.slice(0, Math.floor(maxPages));
  return numbers;
}

/**
 * Let the event loop turn. pdf.js parses in-process on a chain of
 * microtasks, so this is the only point at which a `timeoutMs` timer can
 * fire: once per page, before the page is read.
 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function readPage(document: PDFDocumentProxy, number: number): Promise<PdfPage> {
  await yieldToLoop();
  const page = await document.getPage(number);
  try {
    const content = await page.getTextContent({ includeMarkedContent: false });
    return { number, text: itemsToText(content.items) };
  } finally {
    page.cleanup();
  }
}

async function readPages(document: PDFDocumentProxy, options: PdfTextOptions): Promise<PdfPage[]> {
  const pages: PdfPage[] = [];
  for (const number of selectPages(document.numPages, options)) {
    pages.push(await readPage(document, number));
  }
  return pages;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return firstString(value[0]);
  return undefined;
}

async function readMetadata(document: PDFDocumentProxy): Promise<{ metadata: PdfMetadata; encrypted: boolean }> {
  const { info, metadata: xmp } = await document.getMetadata();
  const dict = (info ?? {}) as Record<string, unknown>;
  const fromXmp = (name: string): string | undefined => firstString(xmp?.get(name));
  const metadata: PdfMetadata = { pageCount: document.numPages };
  const title = firstString(dict.Title) ?? fromXmp("dc:title");
  const author = firstString(dict.Author) ?? fromXmp("dc:creator");
  const subject = firstString(dict.Subject) ?? fromXmp("dc:description");
  const keywords = firstString(dict.Keywords) ?? fromXmp("pdf:keywords");
  const created = (await parsePdfDate(dict.CreationDate)) ?? isoDate(fromXmp("xmp:createdate"));
  const modified = (await parsePdfDate(dict.ModDate)) ?? isoDate(fromXmp("xmp:modifydate"));
  if (title) metadata.title = title;
  if (author) metadata.author = author;
  if (subject) metadata.subject = subject;
  if (keywords) metadata.keywords = keywords;
  if (created) metadata.created = created;
  if (modified) metadata.modified = modified;
  return { metadata, encrypted: dict.EncryptFilterName != null };
}

function isoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Every selected page's text, one entry per page, empty pages included.
 * The building block under {@link pdfToText} and {@link pdfSources}.
 */
export function pdfPages(data: Uint8Array | ArrayBuffer, options: PdfTextOptions = {}): Promise<PdfPage[]> {
  return withDocument(data, options, (document) => readPages(document, options));
}

/** The page-break marker {@link pdfToText} writes ahead of each page. */
export function pageMarker(number: number): string {
  return `--- Page ${number} ---`;
}

function joinPages(pages: readonly PdfPage[]): string {
  return pages
    .filter((page) => page.text)
    .map((page) => `${pageMarker(page.number)}\n${page.text}`)
    .join("\n\n");
}

/**
 * The document as readable text: each page's lines reconstructed from the
 * glyph positions, table-ish rows kept on one line, paragraphs separated by
 * a blank line, and every page introduced by `--- Page N ---`. Pages with
 * no text layer are left out, so a scanned document comes back as an empty
 * string — check {@link pdfInfo} first when that matters.
 */
export async function pdfToText(data: Uint8Array | ArrayBuffer, options: PdfTextOptions = {}): Promise<string> {
  return joinPages(await pdfPages(data, options));
}

/**
 * The document's title, author, subject, keywords, dates and page count,
 * from the info dictionary with XMP as a fallback. Only the fields the
 * document actually has are present.
 */
export function extractPdfMetadata(data: Uint8Array | ArrayBuffer, options: PdfOpenOptions = {}): Promise<PdfMetadata> {
  return withDocument(data, options, async (document) => (await readMetadata(document)).metadata);
}

/**
 * Page count, whether any page has text, and the metadata — enough to decide
 * whether to feed the document to a coercion as text or to fall back to an
 * image path for a scan. Reads every page's text layer (or the first
 * `maxPages`), so on a very long document prefer a cap.
 */
export function pdfInfo(data: Uint8Array | ArrayBuffer, options: PdfOpenOptions & { maxPages?: number } = {}): Promise<PdfInfo> {
  return withDocument(data, options, async (document) => {
    const { metadata, encrypted } = await readMetadata(document);
    let pagesWithText = 0;
    for (const number of selectPages(document.numPages, { maxPages: options.maxPages })) {
      if ((await readPage(document, number)).text) pagesWithText++;
    }
    return { pageCount: document.numPages, hasText: pagesWithText > 0, pagesWithText, encrypted, metadata };
  });
}

/** The metadata as `key: value` lines, the way {@link pdfSource} renders it. */
export function formatPdfMetadata(metadata: PdfMetadata): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`title: ${metadata.title}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.subject) lines.push(`subject: ${metadata.subject}`);
  if (metadata.keywords) lines.push(`keywords: ${metadata.keywords}`);
  if (metadata.created) lines.push(`created: ${metadata.created.toISOString()}`);
  if (metadata.modified) lines.push(`modified: ${metadata.modified.toISOString()}`);
  lines.push(`pages: ${metadata.pageCount}`);
  return lines.join("\n");
}

/**
 * Build one labelled SEMBL source from a document: a "Document metadata"
 * section first, then the text of every selected page with page breaks
 * marked. The metadata goes first on purpose — SEMBL's default truncation
 * keeps the head of a source, so a document that blows the input budget
 * loses its last pages, never its title. For a long document prefer
 * {@link pdfSources}, which lets the budget trim pages individually.
 */
export async function pdfSource(data: Uint8Array | ArrayBuffer, label?: string, options: PdfSourceOptions = {}): Promise<Source> {
  const { meta = true } = options;
  const text = await withDocument(data, options, async (document) => {
    const sections: string[] = [];
    if (meta) {
      const { metadata } = await readMetadata(document);
      sections.push(`Document metadata:\n${formatPdfMetadata(metadata)}`);
    }
    const body = joinPages(await readPages(document, options));
    if (body) sections.push(`Document text:\n${body}`);
    return sections.join("\n\n");
  });
  return label ? { label, text } : { text };
}

/**
 * The document as several sources: the metadata as a short source of its
 * own, then one source per page that has text, labelled `"<label> (page N)"`.
 * SEMBL's budget cuts long sources first, so a 40-page brochure loses the
 * tail of its longest pages rather than every page after the first few,
 * and a page's label survives to name it in provenance. Use this for
 * anything longer than a couple of pages; {@link pdfSource} is simpler when
 * the document is short. Only the sources that have content are returned.
 */
export async function pdfSources(data: Uint8Array | ArrayBuffer, label = "Document", options: PdfSourceOptions = {}): Promise<Source[]> {
  const { meta = true } = options;
  return withDocument(data, options, async (document) => {
    const sources: Source[] = [];
    if (meta) {
      const { metadata } = await readMetadata(document);
      sources.push({ label: `${label} (metadata)`, text: `Document metadata:\n${formatPdfMetadata(metadata)}` });
    }
    for (const page of await readPages(document, options)) {
      if (page.text) sources.push({ label: `${label} (page ${page.number})`, text: page.text });
    }
    return sources;
  });
}

/** Read a PDF from disk as bytes, ready for any reader here. Node only. */
export async function readPdfFile(path: string): Promise<Uint8Array> {
  const buffer = await readFile(path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
