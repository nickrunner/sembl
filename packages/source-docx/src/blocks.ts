/**
 * The document model both parsers produce and the renderer consumes: a
 * flat list of blocks with just enough structure for a language model to
 * read — heading levels, list nesting, table cells — and nothing about how
 * any of it looked.
 */

export interface HeadingBlock {
  kind: "heading";
  /** 1 for the top level, as in Markdown. */
  level: number;
  text: string;
  /** A document title rather than a section heading; never a split point. */
  title?: boolean;
}

export interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}

export interface ListItemBlock {
  kind: "list-item";
  /** 0 for the outermost list. */
  level: number;
  ordered: boolean;
  text: string;
}

export interface TableRow {
  cells: string[];
  header: boolean;
}

export interface TableBlock {
  kind: "table";
  rows: TableRow[];
}

export type Block = HeadingBlock | ParagraphBlock | ListItemBlock | TableBlock;

/** A parsed document, before rendering. */
export interface ParsedDocument {
  blocks: Block[];
  /** Note text by the marker number used in the blocks, in order of first reference. */
  notes: Map<number, string>;
  headers: string[];
  footers: string[];
  metadata: DocxMetadata;
}

/** What the document says about itself, from its core properties. */
export interface DocxMetadata {
  title?: string;
  author?: string;
  created?: Date;
  modified?: Date;
  wordCount?: number;
}

/** How tables are rendered. See {@link DocxTextOptions.tables}. */
export type TableStyle = "pipes" | "lines";

/** The marker a note reference leaves in the text. */
export function noteMarker(n: number): string {
  return `[^${n}]`;
}

/** Collapse runs of spaces and trim each line, keeping deliberate line breaks. */
export function tidy(text: string): string {
  return text
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function pipeCell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function renderTable(table: TableBlock, style: TableStyle): string {
  const rows = table.rows.filter((row) => row.cells.some((cell) => cell.trim()));
  if (rows.length === 0) return "";
  if (style === "lines") {
    return rows.map((row) => row.cells.filter((cell) => cell.trim()).join("\n")).join("\n\n");
  }
  const width = Math.max(...rows.map((row) => row.cells.length));
  const line = (cells: string[]): string => {
    const padded = [...cells, ...Array<string>(width - cells.length).fill("")];
    return `| ${padded.map(pipeCell).join(" | ")} |`;
  };
  // Header rows are the ones the document marks; failing that, the first.
  let headerCount = rows.findIndex((row) => !row.header);
  if (headerCount === -1) headerCount = rows.length;
  if (headerCount === 0) headerCount = 1;
  const out: string[] = [];
  rows.forEach((row, i) => {
    out.push(line(row.cells));
    if (i === headerCount - 1) out.push(`|${" --- |".repeat(width)}`);
  });
  return out.join("\n");
}

/**
 * Render blocks as text: `#` headings, `- ` and `1. ` list items indented
 * by nesting, tables as pipe rows, a blank line around headings and tables.
 */
export function renderBlocks(blocks: readonly Block[], tables: TableStyle = "pipes"): string {
  const lines: string[] = [];
  const counters: number[] = [];
  let previous: Block["kind"] | undefined;
  const gap = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  };

  for (const block of blocks) {
    if (block.kind !== "list-item") counters.length = 0;
    switch (block.kind) {
      case "heading": {
        if (!block.text) continue;
        gap();
        lines.push(`${"#".repeat(Math.max(1, Math.min(6, block.level)))} ${block.text.replace(/\n/g, " ")}`);
        break;
      }
      case "paragraph": {
        if (!block.text) continue;
        if (previous === "table" || previous === "heading") gap();
        lines.push(block.text);
        break;
      }
      case "list-item": {
        if (!block.text) continue;
        if (previous === "table" || previous === "heading") gap();
        counters.length = block.level + 1;
        counters[block.level] = (counters[block.level] ?? 0) + 1;
        const bullet = block.ordered ? `${counters[block.level]}.` : "-";
        lines.push(`${"  ".repeat(block.level)}${bullet} ${block.text.replace(/\n/g, " ")}`);
        break;
      }
      case "table": {
        const text = renderTable(block, tables);
        if (!text) continue;
        gap();
        lines.push(text);
        gap();
        break;
      }
    }
    previous = block.kind;
  }
  return lines.join("\n").trim();
}

/** The notes the blocks refer to, in marker order. */
export function referencedNotes(blocks: readonly Block[], notes: ReadonlyMap<number, string>): [number, string][] {
  const found = new Set<number>();
  const visit = (text: string) => {
    for (const match of text.matchAll(/\[\^(\d+)\]/g)) found.add(Number(match[1]));
  };
  for (const block of blocks) {
    if (block.kind === "table") block.rows.forEach((row) => row.cells.forEach(visit));
    else visit(block.text);
  }
  return [...found]
    .sort((a, b) => a - b)
    .flatMap((n) => (notes.has(n) ? [[n, notes.get(n)!] as [number, string]] : []));
}

/** Render notes as a trailing section. */
export function renderNotes(notes: readonly [number, string][]): string {
  if (notes.length === 0) return "";
  return `Footnotes:\n${notes.map(([n, text]) => `${noteMarker(n)}: ${text.replace(/\n/g, " ")}`).join("\n")}`;
}

/** Render the metadata as the leading section, in the style of source-html. */
export function renderMetadata(metadata: DocxMetadata): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`title: ${metadata.title}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.created) lines.push(`created: ${metadata.created.toISOString()}`);
  if (metadata.modified) lines.push(`modified: ${metadata.modified.toISOString()}`);
  if (metadata.wordCount !== undefined) lines.push(`words: ${metadata.wordCount}`);
  return lines.length > 0 ? `Document metadata:\n${lines.join("\n")}` : "";
}

/** A date from a property value, or nothing when it does not parse. */
export function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A count from a property value, or nothing when it is not a number. */
export function parseCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
