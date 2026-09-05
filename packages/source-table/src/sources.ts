import type { Source } from "@sembl/core";
import { parseTable } from "./table.js";
import type { Table, TableData, TableOptions } from "./table.js";

/** Options for {@link rowSources} and {@link tableRows}. */
export interface RowSourceOptions {
  /**
   * Label prefix for each row's source; the row number follows it. Default
   * `"Row"`, or `"<sheet name> row"` when the table came from a named sheet,
   * so a source reads `Row 7` or `Listings row 7` — the row a person would
   * find in the spreadsheet, header row counted.
   */
  label?: string;
}

/** Options for {@link tableText} and {@link tableSource}. */
export interface TableSourceOptions {
  /** Label for the source. Default: the sheet name, else `"Table"`. */
  label?: string;
  /** Widest a column is padded to; longer cells overflow rather than pad. Default 40. */
  columnWidth?: number;
}

function collapse(cell: string): string {
  return cell.replace(/\s+/g, " ").trim();
}

/** A row's label: the prefix and its 1-based row number in the file. */
export function rowLabel(table: Table, index: number, prefix?: string): string {
  const base = prefix ?? (table.name ? `${table.name} row` : "Row");
  return `${base} ${table.rowNumbers[index] ?? index + 1}`;
}

/**
 * One row as `Header: value` lines, blank cells left out, so the text is
 * self-describing without the rest of the table. A multi-line cell keeps its
 * line breaks, indented under its header.
 */
export function rowText(table: Table, index: number): string {
  const row = table.rows[index] ?? [];
  const lines: string[] = [];
  table.headers.forEach((header, c) => {
    const value = (row[c] ?? "").trim();
    if (!value) return;
    lines.push(`${header}: ${value.replace(/\r?\n/g, "\n  ")}`);
  });
  return lines.join("\n");
}

/**
 * Every data row of a parsed table as its own labelled source, for
 * `coerceMany`. Each source carries the row's cells as `Header: value`
 * lines, so a row is complete on its own and provenance points back to a
 * row number a person can find.
 */
export function rowSources(table: Table, options: RowSourceOptions = {}): Source[] {
  return table.rows.map((_, i) => ({ label: rowLabel(table, i, options.label), text: rowText(table, i) }));
}

/**
 * A whole table as aligned text: a header line, a rule, then one line per
 * row with ` | ` between cells. Cells are collapsed to one line each. Pass
 * `maxRows` to the parser to cap what is rendered; a note says how many
 * rows were left out when `table.rows` was cut.
 */
export function tableText(table: Table, options: TableSourceOptions = {}): string {
  const { columnWidth = 40 } = options;
  const grid = [table.headers, ...table.rows.map((row) => row.map(collapse))];
  const widths = table.headers.map((_, c) =>
    Math.min(columnWidth, Math.max(...grid.map((row) => (row[c] ?? "").length))),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c]))).join(" | ").trimEnd();
  const lines = [line(table.headers), widths.map((w) => "-".repeat(w)).join("-+-"), ...grid.slice(1).map(line)];
  const omitted = table.totalRows - table.rows.length;
  if (omitted > 0) lines.push(`(${omitted} more ${omitted === 1 ? "row" : "rows"} not shown)`);
  return lines.join("\n");
}

/**
 * Parse a CSV or workbook and return one labelled source per data row, ready
 * for `coerceMany`. Options select the sheet, the header row, and how many
 * rows and columns to keep.
 */
export async function tableRows(data: TableData, options: TableOptions & RowSourceOptions = {}): Promise<Source[]> {
  const { label, ...tableOptions } = options;
  const table = await parseTable(data, tableOptions);
  return rowSources(table, label === undefined ? {} : { label });
}

/**
 * Parse a CSV or workbook and return the whole table (or one sheet of it) as
 * a single aligned-text source — for the cases where the file *is* one
 * object, like a rate card or a seasonal price table. `maxRows` caps what
 * is rendered.
 */
export async function tableSource(data: TableData, options: TableOptions & TableSourceOptions = {}): Promise<Source> {
  const { label, columnWidth, ...tableOptions } = options;
  const table = await parseTable(data, tableOptions);
  const textOptions: TableSourceOptions = {};
  if (columnWidth !== undefined) textOptions.columnWidth = columnWidth;
  return { label: label ?? table.name ?? "Table", text: tableText(table, textOptions) };
}
