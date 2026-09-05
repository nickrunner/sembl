import ExcelJS from "exceljs";
import type { RawSheet } from "./table.js";

/**
 * XLSX reading, on top of exceljs. Everything here is about turning what a
 * cell holds into the text a model should see: dates as ISO, numbers as the
 * shortest string that round-trips, formulas as their cached result, rich
 * text flattened, hyperlinks as their text, errors as the error code, and
 * the cells a merge covers marked so the header pass can name them.
 */

type CellValue = ExcelJS.CellValue;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * A spreadsheet date as ISO text. Excel dates carry no zone, and exceljs
 * decodes them as UTC, so the UTC parts are the parts the sheet showed.
 * A date with no time of day renders as `YYYY-MM-DD`; otherwise the time is
 * kept, seconds included, with no zone suffix.
 */
export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const s = date.getUTCSeconds();
  if (h === 0 && m === 0 && s === 0 && date.getUTCMilliseconds() === 0) return day;
  return `${day}T${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Render one cell value as text. */
export function renderCellValue(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return formatDate(value);
  if ("richText" in value) return value.richText.map((run) => run.text).join("");
  if ("hyperlink" in value) {
    const text = value.text as unknown;
    if (typeof text === "string") return text;
    if (text && typeof text === "object" && "richText" in (text as object)) {
      return renderCellValue(text as CellValue);
    }
    return value.hyperlink;
  }
  if ("error" in value) return value.error;
  if ("formula" in value || "sharedFormula" in value) {
    return value.result === undefined ? "" : renderCellValue(value.result as CellValue);
  }
  return String(value);
}

/** Options for {@link readWorkbook}. */
export interface ReadWorkbookOptions {
  /** Stop reading cells past this column; very wide sheets are cut here. */
  maxColumns?: number;
}

/**
 * Every worksheet of an XLSX file as a raw grid. Cells a merge covers (but
 * does not anchor) come back as `undefined`; everything else is rendered
 * text, so the rest of the package never sees exceljs values.
 */
export async function readWorkbook(bytes: Uint8Array, options: ReadWorkbookOptions = {}): Promise<RawSheet[]> {
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const limit = options.maxColumns;
  return workbook.worksheets.map((sheet) => {
    const rows: (string | undefined)[][] = [];
    const columnCount = limit === undefined ? sheet.columnCount : Math.min(sheet.columnCount, limit);
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      const row = sheet.getRow(r);
      const cells: (string | undefined)[] = [];
      const width = Math.min(row.cellCount, columnCount);
      for (let c = 1; c <= width; c += 1) {
        const cell = row.getCell(c);
        cells.push(cell.isMerged && cell.master !== cell ? undefined : renderCellValue(cell.value));
      }
      rows.push(cells);
    }
    return { name: sheet.name, rows };
  });
}
