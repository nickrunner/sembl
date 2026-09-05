import { parseCsv } from "./csv.js";
import type { CsvOptions } from "./csv.js";
import { readWorkbook } from "./xlsx.js";

/**
 * A parsed table: one header per column and the data rows beneath it, every
 * cell already a string. This is the shape everything else in the package
 * renders from, so a caller with rows from somewhere else — a database, an
 * API — can build one by hand and use the same rendering.
 */
export interface Table {
  /** The sheet name, when the table came from a workbook. */
  name?: string;
  /** One header per column, synthesised as `Column N` where the file had none. */
  headers: string[];
  /** Data rows, each padded or cut to `headers.length`. */
  rows: string[][];
  /**
   * The 1-based row number in the file of each entry in `rows`, so a
   * source label or an error can point at the row a person would find in
   * their spreadsheet.
   */
  rowNumbers: number[];
  /**
   * How many data rows the sheet held before `maxRows` cut it, blank rows
   * excluded when `skipEmpty` is on. Equal to `rows.length` when nothing
   * was cut.
   */
  totalRows: number;
}

/** What the parsers accept: bytes of an XLSX or CSV file, or CSV text. */
export type TableData = Uint8Array | ArrayBuffer | string;

/** Options shared by everything that parses a table. */
export interface TableOptions extends CsvOptions {
  /** `"csv"` or `"xlsx"`. Detected from the bytes when not given. */
  format?: "csv" | "xlsx";
  /** Which worksheet, by name or 0-based index. Default: the first sheet. */
  sheet?: string | number;
  /**
   * The 1-based row holding the headers. Rows above it are skipped. Default
   * 1. Pass `0` when the table has no header row: every column is named
   * `Column N` and the data starts on row 1.
   */
  headerRow?: number;
  /** Drop rows whose every cell is blank. Default true. */
  skipEmpty?: boolean;
  /** Keep only the first N data rows. */
  maxRows?: number;
  /** Keep only the first N columns; very wide sheets are cut here. Default 256. */
  maxColumns?: number;
}

const DEFAULT_MAX_COLUMNS = 256;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

function toBytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Which format some bytes are: XLSX when they start with a ZIP local file
 * header, CSV otherwise. Strings are always CSV text.
 */
export function detectFormat(data: TableData): "csv" | "xlsx" {
  if (typeof data === "string") return "csv";
  const bytes = toBytes(data);
  return ZIP_MAGIC.every((b, i) => bytes[i] === b) ? "xlsx" : "csv";
}

function decodeText(data: TableData): string {
  if (typeof data === "string") return data;
  // `fatal: false` so a stray byte degrades to U+FFFD rather than an error;
  // the BOM is stripped by the CSV parser itself.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(toBytes(data));
}

/** A raw grid straight from a parser: ragged rows, any cell types already rendered. */
export interface RawSheet {
  name?: string;
  /** Cells rendered as text; `undefined` marks a cell a merge covers. */
  rows: (string | undefined)[][];
}

function isBlank(cell: string | undefined): boolean {
  return cell === undefined || cell.trim() === "";
}

/**
 * Header names that are unique and never empty: a blank or merged-over
 * header becomes `Column N` (1-based, as a spreadsheet numbers columns) and a
 * repeated name gets a ` (2)`, ` (3)` suffix so that `Header: value` lines
 * and column mappings can name a column unambiguously.
 */
export function normaliseHeaders(raw: readonly (string | undefined)[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((cell, i) => {
    const base = isBlank(cell) ? `Column ${i + 1}` : cell!.replace(/\s+/g, " ").trim();
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

/**
 * Shape a raw grid into a {@link Table}: pick the header row, drop the rows
 * above it, trim trailing empty columns, cap the width, pad every row to it.
 */
export function shapeTable(sheet: RawSheet, options: TableOptions = {}): Table {
  const { headerRow = 1, skipEmpty = true, maxRows, maxColumns = DEFAULT_MAX_COLUMNS } = options;
  if (!Number.isInteger(headerRow) || headerRow < 0) {
    throw new RangeError(`headerRow must be a non-negative integer, got ${String(headerRow)}`);
  }
  if (!Number.isInteger(maxColumns) || maxColumns < 1) {
    throw new RangeError(`maxColumns must be a positive integer, got ${String(maxColumns)}`);
  }

  const headerCells = headerRow > 0 ? (sheet.rows[headerRow - 1] ?? []) : [];
  const firstDataRow = headerRow; // 0-based index of the first data row

  // Width: the widest of the header and the data, minus trailing columns no
  // row uses, capped.
  let width = 0;
  const widthOf = (row: readonly (string | undefined)[]) => {
    let w = row.length;
    while (w > 0 && isBlank(row[w - 1])) w -= 1;
    return w;
  };
  width = Math.max(widthOf(headerCells), ...sheet.rows.slice(firstDataRow).map(widthOf));
  width = Math.min(width, maxColumns);

  const headers = normaliseHeaders(Array.from({ length: width }, (_, i) => headerCells[i]));

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let totalRows = 0;
  for (let i = firstDataRow; i < sheet.rows.length; i += 1) {
    const raw = sheet.rows[i];
    const cells = Array.from({ length: width }, (_, c) => raw[c] ?? "");
    if (skipEmpty && cells.every((cell) => cell.trim() === "")) continue;
    totalRows += 1;
    if (maxRows !== undefined && rows.length >= maxRows) continue;
    rows.push(cells);
    rowNumbers.push(i + 1);
  }

  const table: Table = { headers, rows, rowNumbers, totalRows };
  if (sheet.name !== undefined) table.name = sheet.name;
  return table;
}

/** Every sheet of the input as a raw grid, in workbook order. CSV is one unnamed sheet. */
async function readSheets(data: TableData, options: TableOptions): Promise<RawSheet[]> {
  const format = options.format ?? detectFormat(data);
  if (format === "xlsx") {
    if (typeof data === "string") {
      throw new TypeError("XLSX input must be bytes (Uint8Array or ArrayBuffer), not a string");
    }
    const xlsxOptions: { maxColumns?: number } = {};
    if (options.maxColumns !== undefined) xlsxOptions.maxColumns = options.maxColumns;
    return readWorkbook(toBytes(data), xlsxOptions);
  }
  const csvOptions: CsvOptions = {};
  if (options.delimiter !== undefined) csvOptions.delimiter = options.delimiter;
  return [{ rows: parseCsv(decodeText(data), csvOptions) }];
}

function pickSheet(sheets: RawSheet[], selector: string | number | undefined): RawSheet {
  if (sheets.length === 0) throw new RangeError("The workbook has no worksheets");
  if (selector === undefined) return sheets[0];
  if (typeof selector === "number") {
    const sheet = sheets[selector];
    if (!sheet) {
      throw new RangeError(`No sheet at index ${selector}; the workbook has ${sheets.length}`);
    }
    return sheet;
  }
  const byName = sheets.find((s) => s.name === selector)
    ?? sheets.find((s) => s.name?.toLowerCase() === selector.toLowerCase());
  if (!byName) {
    const names = sheets.map((s) => JSON.stringify(s.name ?? "")).join(", ");
    throw new RangeError(`No sheet named ${JSON.stringify(selector)}; the workbook has ${names}`);
  }
  return byName;
}

/**
 * Parse one table: the selected sheet of a workbook, or the CSV. The
 * result is plain data — render it with {@link rowSources} or
 * {@link tableText}, or hand it to {@link applyMapping}.
 */
export async function parseTable(data: TableData, options: TableOptions = {}): Promise<Table> {
  const sheets = await readSheets(data, options);
  return shapeTable(pickSheet(sheets, options.sheet), options);
}

/** Every sheet of a workbook as a table, in workbook order. A CSV is one table. */
export async function parseTables(data: TableData, options: Omit<TableOptions, "sheet"> = {}): Promise<Table[]> {
  const sheets = await readSheets(data, options);
  return sheets.map((sheet) => shapeTable(sheet, options));
}

/** Names of the worksheets in a workbook, in order. A CSV has one unnamed sheet. */
export async function sheetNames(data: TableData, options: Pick<TableOptions, "format"> = {}): Promise<(string | undefined)[]> {
  const sheets = await readSheets(data, options);
  return sheets.map((sheet) => sheet.name);
}

/** Each row of a table as a record keyed by header. */
export function tableRecords(table: Table): Record<string, string>[] {
  return table.rows.map((row) => Object.fromEntries(table.headers.map((h, i) => [h, row[i] ?? ""])));
}
