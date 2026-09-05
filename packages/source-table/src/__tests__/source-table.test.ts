import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { coerce, defineSchema, field } from "@sembl/core";
import type { Provider, RuntimeSchema } from "@sembl/core";
import {
  applyMapping,
  castCell,
  detectDelimiter,
  detectFormat,
  formatDate,
  mappingInput,
  mappingSchema,
  mappingText,
  normaliseHeaders,
  parseCsv,
  parseTable,
  parseTables,
  renderCellValue,
  rowSources,
  sheetNames,
  tableRecords,
  tableRows,
  tableSource,
  tableText,
  targetFields,
} from "../index.js";
import type { ColumnMapping, Table } from "../index.js";

const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
const listingsCsv = readFileSync(fixture("listings.csv"), "utf8");

/**
 * A workbook built in a setup step rather than checked in: two sheets, a
 * merged header, an empty header, dates, numbers, a formula, rich text, a
 * boolean and an empty row.
 */
let workbook: Uint8Array;
beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  const rates = wb.addWorksheet("Rates");
  rates.addRow(["Season", "From", "To", "Nightly", "Min nights", "Notes", "", "Address"]);
  rates.mergeCells("H1:I1");
  rates.addRow(["Low", new Date(Date.UTC(2026, 0, 6)), new Date(Date.UTC(2026, 2, 31)), 95.5, 2, "", "extra", "Rua 7", "Lisbon"]);
  rates.addRow(["High", new Date(Date.UTC(2026, 5, 1, 15, 30)), new Date(Date.UTC(2026, 7, 31)), 1250, 7, { richText: [{ text: "Peak " }, { text: "weeks", font: { bold: true } }] }]);
  rates.addRow([]);
  rates.addRow(["Total", null, null, { formula: "D2+D3", result: 1345.5 }, true, { text: "site", hyperlink: "https://example.com" }]);

  const guests = wb.addWorksheet("Guests");
  guests.addRow(["Name", "Nights"]);
  guests.addRow(["Ada", 3]);
  guests.addRow(["Grace", 5]);

  const wide = wb.addWorksheet("Wide");
  wide.addRow(Array.from({ length: 400 }, (_, i) => `H${i + 1}`));
  wide.addRow(Array.from({ length: 400 }, (_, i) => i + 1));

  workbook = new Uint8Array(await wb.xlsx.writeBuffer());
});

describe("parseCsv", () => {
  it("handles quoted fields with delimiters, doubled quotes and embedded newlines", () => {
    const rows = parseCsv(listingsCsv);
    expect(rows[0]).toEqual(["Property", "Type", "Guests", "Rate (EUR)", "Pets?", "Features", "Street", "Town", "Postcode", "Notes"]);
    expect(rows[1][9]).toBe("Two bedrooms, sleeps 6.\nSauna by the water.");
    expect(rows[2][0]).toBe("Alfama Flat, top floor");
    expect(rows[2][9]).toBe('Says "no pets" twice');
    expect(rows).toHaveLength(6);
  });

  it("strips a BOM, detects tabs, and takes CRLF and a quoted CRLF in stride", () => {
    const text = "﻿Name\tCity\r\nAda\tLondon\r\nGrace\t\"New\r\nYork\"\r\n";
    expect(detectDelimiter(text)).toBe("\t");
    expect(parseCsv(text)).toEqual([["Name", "City"], ["Ada", "London"], ["Grace", "New\r\nYork"]]);
  });

  it("detects semicolons and pipes, prefers the consistent delimiter, and honours an explicit one", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a|b\n1|2\n")).toBe("|");
    // Commas inside quotes do not vote; the semicolons are consistent.
    expect(detectDelimiter('"x, y";b\n"1, 2";3\n')).toBe(";");
    expect(parseCsv("a;b,c\n1;2,3", { delimiter: "," })).toEqual([["a;b", "c"], ["1;2", "3"]]);
    expect(() => parseCsv("a", { delimiter: ",," })).toThrow(RangeError);
  });

  it("keeps ragged rows, empty cells and lone CR breaks, and drops the trailing line break", () => {
    expect(parseCsv("a,b,c\r1\r,,\r")).toEqual([["a", "b", "c"], ["1"], ["", "", ""]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv('""')).toEqual([[""]]);
  });
});

describe("parseTable", () => {
  it("shapes a CSV string into headers and padded rows with file row numbers", async () => {
    const table = await parseTable(listingsCsv);
    expect(table.name).toBeUndefined();
    expect(table.headers).toHaveLength(10);
    expect(table.rows).toHaveLength(4);
    expect(table.rows.every((r) => r.length === 10)).toBe(true);
    // Row 5 of the file is blank and skipped; row numbers still point at the file.
    expect(table.rowNumbers).toEqual([2, 3, 4, 6]);
    expect(table.totalRows).toBe(4);
  });

  it("accepts bytes with a BOM and an ArrayBuffer", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b\n1,2\n")]);
    expect(detectFormat(bytes)).toBe("csv");
    expect((await parseTable(bytes)).headers).toEqual(["a", "b"]);
    expect((await parseTable(bytes.buffer as ArrayBuffer)).rows).toEqual([["1", "2"]]);
  });

  it("keeps blank rows when asked, caps rows and reports the total", async () => {
    const kept = await parseTable(listingsCsv, { skipEmpty: false });
    expect(kept.rows).toHaveLength(5);
    const capped = await parseTable(listingsCsv, { maxRows: 2 });
    expect(capped.rows.map((r) => r[0])).toEqual(["Sea Cabin", "Alfama Flat, top floor"]);
    expect(capped.totalRows).toBe(4);
  });

  it("takes the header from a later row, or synthesises headers with none", async () => {
    const text = "Export 2026-09-01\n\nName,City\nAda,London\n";
    const table = await parseTable(text, { headerRow: 3 });
    expect(table.headers).toEqual(["Name", "City"]);
    expect(table.rows).toEqual([["Ada", "London"]]);
    expect(table.rowNumbers).toEqual([4]);
    const headless = await parseTable("Ada,London\nGrace,Paris", { headerRow: 0 });
    expect(headless.headers).toEqual(["Column 1", "Column 2"]);
    expect(headless.rows).toHaveLength(2);
    await expect(parseTable(text, { headerRow: -1 })).rejects.toThrow(RangeError);
  });

  it("names blank and duplicate headers unambiguously", () => {
    expect(normaliseHeaders(["Name", "", "  ", "Name", "Name", undefined, "A  B "])).toEqual([
      "Name", "Column 2", "Column 3", "Name (2)", "Name (3)", "Column 6", "A B",
    ]);
  });

  it("trims trailing empty columns and caps the width with maxColumns", async () => {
    const table = await parseTable("a,b,,\n1,2,,\n");
    expect(table.headers).toEqual(["a", "b"]);
    const cut = await parseTable("a,b,c,d\n1,2,3,4\n", { maxColumns: 2 });
    expect(cut.headers).toEqual(["a", "b"]);
    expect(cut.rows).toEqual([["1", "2"]]);
    await expect(parseTable("a", { maxColumns: 0 })).rejects.toThrow(RangeError);
  });

  it("builds records keyed by header", async () => {
    const [first] = tableRecords(await parseTable("Name,City\nAda,London"));
    expect(first).toEqual({ Name: "Ada", City: "London" });
  });
});

describe("XLSX", () => {
  it("detects the format and reads the first sheet by default", async () => {
    expect(detectFormat(workbook)).toBe("xlsx");
    const table = await parseTable(workbook);
    expect(table.name).toBe("Rates");
    expect(table.headers).toEqual(["Season", "From", "To", "Nightly", "Min nights", "Notes", "Column 7", "Address", "Column 9"]);
  });

  it("renders dates as ISO, numbers as written, formulas as their result, rich text and hyperlinks as text", async () => {
    const table = await parseTable(workbook);
    expect(table.rows[0]).toEqual(["Low", "2026-01-06", "2026-03-31", "95.5", "2", "", "extra", "Rua 7", "Lisbon"]);
    expect(table.rows[1].slice(0, 6)).toEqual(["High", "2026-06-01T15:30:00", "2026-08-31", "1250", "7", "Peak weeks"]);
    // The empty row 4 is skipped; the totals row keeps its file number.
    expect(table.rowNumbers).toEqual([2, 3, 5]);
    expect(table.rows[2].slice(0, 6)).toEqual(["Total", "", "", "1345.5", "true", "site"]);
  });

  it("selects a sheet by name, case-insensitively, or by index, and lists them", async () => {
    expect((await parseTable(workbook, { sheet: "Guests" })).rows).toEqual([["Ada", "3"], ["Grace", "5"]]);
    expect((await parseTable(workbook, { sheet: "guests" })).name).toBe("Guests");
    expect((await parseTable(workbook, { sheet: 1 })).name).toBe("Guests");
    expect(await sheetNames(workbook)).toEqual(["Rates", "Guests", "Wide"]);
    expect((await parseTables(workbook)).map((t) => t.name)).toEqual(["Rates", "Guests", "Wide"]);
    await expect(parseTable(workbook, { sheet: "Nope" })).rejects.toThrow(/No sheet named "Nope"/);
    await expect(parseTable(workbook, { sheet: 9 })).rejects.toThrow(/No sheet at index 9/);
  });

  it("cuts a very wide sheet at maxColumns", async () => {
    const wide = await parseTable(workbook, { sheet: "Wide" });
    expect(wide.headers).toHaveLength(256);
    const narrow = await parseTable(workbook, { sheet: "Wide", maxColumns: 3 });
    expect(narrow.headers).toEqual(["H1", "H2", "H3"]);
    expect(narrow.rows).toEqual([["1", "2", "3"]]);
  });

  it("refuses XLSX as a string and honours an explicit format", async () => {
    await expect(parseTable("PK", { format: "xlsx" })).rejects.toThrow(TypeError);
    const csvBytes = new TextEncoder().encode("a,b\n1,2");
    expect((await parseTable(csvBytes, { format: "csv" })).rows).toEqual([["1", "2"]]);
  });

  it("renders every cell value kind", () => {
    expect(renderCellValue(null)).toBe("");
    expect(renderCellValue(undefined)).toBe("");
    expect(renderCellValue(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(renderCellValue(Number.NaN)).toBe("");
    expect(renderCellValue(false)).toBe("false");
    expect(renderCellValue({ error: "#N/A" })).toBe("#N/A");
    expect(renderCellValue({ formula: "A1", result: new Date(Date.UTC(2026, 11, 25)) })).toBe("2026-12-25");
    expect(renderCellValue({ sharedFormula: "A1" })).toBe("");
    expect(renderCellValue({ text: { richText: [{ text: "a" }, { text: "b" }] } as never, hyperlink: "x" })).toBe("ab");
    expect(formatDate(new Date(Number.NaN))).toBe("");
    expect(formatDate(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 1)))).toBe("2026-01-01T00:00:00");
  });
});

describe("rows as sources", () => {
  it("renders one labelled Header: value source per row, blank cells left out", async () => {
    const sources = await tableRows(listingsCsv);
    expect(sources.map((s) => s.label)).toEqual(["Row 2", "Row 3", "Row 4", "Row 6"]);
    expect(sources[2].text).toBe(
      "Property: The Barn\nType: barn\nGuests: 10\nRate (EUR): 310\nPets?: yes\nFeatures: kitchen; parking; ev charger\nTown: Dorset",
    );
  });

  it("indents a multi-line cell under its header", async () => {
    const [cabin] = await tableRows(listingsCsv, { maxRows: 1 });
    expect(cabin.text).toContain("Notes: Two bedrooms, sleeps 6.\n  Sauna by the water.");
  });

  it("labels with the sheet name by default and with a prefix when given", async () => {
    const fromSheet = await tableRows(workbook, { sheet: "Guests" });
    expect(fromSheet.map((s) => s.label)).toEqual(["Guests row 2", "Guests row 3"]);
    const prefixed = await tableRows(listingsCsv, { label: "Listing", maxRows: 2 });
    expect(prefixed.map((s) => s.label)).toEqual(["Listing 2", "Listing 3"]);
  });

  it("works on a table built by hand", () => {
    const table: Table = { headers: ["A", "B"], rows: [["1", ""], ["", "2"]], rowNumbers: [1, 2], totalRows: 2 };
    expect(rowSources(table).map((s) => s.text)).toEqual(["A: 1", "B: 2"]);
  });
});

describe("whole table as a source", () => {
  it("renders an aligned table with a header rule and a note for omitted rows", async () => {
    const source = await tableSource(workbook, { sheet: "Guests" });
    expect(source.label).toBe("Guests");
    expect(source.text).toBe("Name  | Nights\n------+-------\nAda   | 3\nGrace | 5");
    const capped = await tableSource(listingsCsv, { maxRows: 1, label: "Rate card" });
    expect(capped.label).toBe("Rate card");
    expect(capped.text.split("\n").slice(0, 3)).toEqual([
      "Property  | Type  | Guests | Rate (EUR) | Pets? | Features             | Street        | Town   | Postcode | Notes",
      "----------+-------+--------+------------+-------+----------------------+---------------+--------+----------+-----------------------------------------",
      "Sea Cabin | cabin | 6      | 250        | yes   | wifi; sauna; hot tub | 12 Shore Road | Bergen | 5003     | Two bedrooms, sleeps 6. Sauna by the water.",
    ]);
    expect(capped.text.endsWith("(3 more rows not shown)")).toBe(true);
  });

  it("collapses multi-line cells and caps padding at columnWidth", async () => {
    const table = await parseTable(listingsCsv, { maxRows: 1 });
    const text = tableText(table, { columnWidth: 8 });
    expect(text).toContain("Two bedrooms, sleeps 6. Sauna by the water.");
    expect(text.split("\n")[1]).toBe("---------+-------+--------+----------+-------+----------+----------+--------+----------+---------");
    expect(text.split("\n")[2].startsWith("Sea Cabin | cabin | 6      | 250      | yes   | wifi; sauna; hot tub | ")).toBe(true);
    expect((await tableSource("a,b\n1,2")).label).toBe("Table");
  });
});

const Address = defineSchema("Address", "Where a property is.", {
  street: field.string("Street number and street name.").optional(),
  city: field.string("City or municipality."),
  zip: field.string("Postal code.").optional(),
});

const Listing = defineSchema("Listing", "A short-term rental listing.", {
  name: field.string("Display name for the listing.", { maxLength: 60 }),
  sleeps: field.number("How many guests can sleep there.").optional(),
  nightlyRate: field.number("Nightly rate as a plain number.").optional(),
  kind: field.enum(["house", "flat", "cabin"], "The kind of property.").optional(),
  amenities: field.valuesFrom("amenities", "Amenities the property offers.").array().optional(),
  petsAllowed: field.boolean("Whether guests may bring pets.").optional(),
  address: field.object(Address, "Where the property is.").optional(),
});

describe("mappingSchema", () => {
  it("offers every target field, nested ones as dotted paths, as an enum with descriptions in the prompt", () => {
    const schema = mappingSchema(Listing);
    expect(schema.id).toBe("ListingColumnMapping");
    expect(schema.description).toContain("Listing (A short-term rental listing)");
    expect(schema.fields.map((f) => f.name)).toEqual(["columns"]);
    expect(schema.fields[0].type).toEqual({ kind: "array", items: { kind: "object", nestedSchemaId: "ListingColumnMappingColumn" } });

    const column = schema.bundle.schemas.ListingColumnMappingColumn;
    expect(column.fields.map((f) => `${f.name}${f.required ? "" : "?"}`)).toEqual(["column", "field?", "transform?", "confidence?"]);
    const fieldEnum = column.fields[1];
    expect(fieldEnum.type).toEqual({
      kind: "enum",
      values: ["name", "sleeps", "nightlyRate", "kind", "amenities", "petsAllowed", "address.street", "address.city", "address.zip"],
    });
    expect(fieldEnum.description).toContain("- address.city: City or municipality. (string)");
    expect(fieldEnum.description).toContain('- kind: The kind of property. (one of "house", "flat", "cabin")');
    expect(fieldEnum.description).toContain("- amenities: Amenities the property offers. (list of a value from the \"amenities\" taxonomy)");
    expect(column.fields[3].type).toEqual({ kind: "enum", values: ["high", "medium", "low"] });
  });

  it("offers a nested object whole when its schema is not in the bundle, and takes an explicit bundle and id", () => {
    const plain: RuntimeSchema = { id: "Plain", description: "x", fields: Listing.fields };
    expect(targetFields(plain).map((f) => f.path)).toContain("address");
    expect(targetFields(plain, Listing.bundle).map((f) => f.path)).toContain("address.city");
    const custom = mappingSchema(plain, { bundle: Listing.bundle, id: "Wizard" });
    expect(custom.id).toBe("Wizard");
    expect(Object.keys(custom.bundle.schemas).sort()).toEqual(["Wizard", "WizardColumn"]);
  });

  it("does not loop on a self-referencing schema and rejects a target with no fields", () => {
    const Node: RuntimeSchema = {
      id: "Node",
      description: "x",
      fields: [
        { name: "label", description: "l", type: { kind: "string" }, required: true },
        { name: "parent", description: "p", type: { kind: "object", nestedSchemaId: "Node" }, required: false },
      ],
    };
    expect(targetFields(Node, { schemas: { Node } }).map((f) => f.path)).toEqual(["label", "parent"]);
    expect(() => mappingSchema({ id: "Empty", description: "", fields: [] })).toThrow(RangeError);
  });
});

describe("mappingInput", () => {
  it("renders the numbered columns and a sample of rows", async () => {
    const source = await mappingInput(listingsCsv, { sampleRows: 2 });
    expect(source.label).toBe("Table sample");
    expect(source.text).toContain("Columns (10):\n1. Property\n2. Type\n");
    expect(source.text).toContain("Sample rows (2 of 4):\n");
    expect(source.text).toContain("Sea Cabin");
    expect(source.text).not.toContain("The Barn");
    expect(source.text).not.toContain("more rows not shown");
  });

  it("uses the sheet name and a default of five rows", async () => {
    const source = await mappingInput(workbook, { sheet: "Guests" });
    expect(source.label).toBe("Guests sample");
    expect(source.text).toContain("Sample rows (2 of 2)");
    const table = await parseTable(listingsCsv);
    expect(mappingText(table)).toContain("Sample rows (4 of 4)");
  });
});

describe("applyMapping", () => {
  const mapping: ColumnMapping = {
    columns: [
      { column: "Property", field: "name", confidence: "high" },
      { column: "Type", field: "kind" },
      { column: "guests", field: "sleeps" },
      { column: "Rate (EUR)", field: "nightlyRate", transform: "The rate is in euros." },
      { column: "Pets?", field: "petsAllowed", transform: "yes/no to boolean" },
      { column: "Features", field: "amenities", transform: "split on ;" },
      { column: "Street", field: "address.street" },
      { column: "Town", field: "address.city" },
      { column: "Postcode", field: "address.zip" },
      { column: "Notes", field: null },
      { column: "Missing", field: "name" },
    ],
  };

  it("copies mapped cells as strings, builds nested paths and skips blanks and unmapped columns", async () => {
    const table = await parseTable(listingsCsv);
    const rows = applyMapping(table, mapping);
    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual({
      name: "The Barn",
      kind: "barn",
      sleeps: "10",
      nightlyRate: "310",
      petsAllowed: "yes",
      amenities: "kitchen; parking; ev charger",
      address: { city: "Dorset" },
    });
    expect("Notes" in rows[0]).toBe(false);
  });

  it("casts by the target's field types when given the schema", async () => {
    const rows = applyMapping(await parseTable(listingsCsv), mapping, { schema: Listing });
    expect(rows[0]).toEqual({
      name: "Sea Cabin",
      kind: "cabin",
      sleeps: 6,
      nightlyRate: 250,
      petsAllowed: true,
      amenities: ["wifi", "sauna", "hot tub"],
      address: { street: "12 Shore Road", city: "Bergen", zip: "5003" },
    });
    // A value that does not cast stays the string it was.
    expect(rows[2].kind).toBe("barn");
    expect(rows[1].petsAllowed).toBe(false);
  });

  it("takes records as well as a table", () => {
    const rows = applyMapping([{ Property: "X", Town: "Y", Guests: " 4 " }], mapping, { schema: Listing });
    expect(rows).toEqual([{ name: "X", sleeps: 4, address: { city: "Y" } }]);
  });

  it("casts cells leniently", () => {
    expect(castCell("€1,250.50", { kind: "number" })).toBe(1250.5);
    expect(castCell("EUR 95", { kind: "number" })).toBe(95);
    expect(castCell("95 EUR", { kind: "number" })).toBe(95);
    expect(castCell("1e3", { kind: "number" })).toBe(1000);
    expect(castCell("about 95", { kind: "number" })).toBe("about 95");
    expect(castCell("Yes", { kind: "boolean" })).toBe(true);
    expect(castCell("N", { kind: "boolean" })).toBe(false);
    expect(castCell("maybe", { kind: "boolean" })).toBe("maybe");
    expect(castCell("FLAT", { kind: "enum", values: ["house", "flat"] })).toBe("flat");
    expect(castCell("a, b,c", { kind: "array", items: { kind: "string" } })).toEqual(["a", "b", "c"]);
    expect(castCell("1|2", { kind: "array", items: { kind: "number" } })).toEqual([1, 2]);
    expect(castCell("x\ny", { kind: "array", items: { kind: "string" } })).toEqual(["x", "y"]);
    expect(castCell("  keep ", { kind: "string" })).toBe("keep");
  });
});

describe("the two-step flow with a mock provider", () => {
  it("coerces a mapping once, then applies it to every row without the model", async () => {
    let calls = 0;
    let sawEnum: string[] | undefined;
    const provider: Provider = {
      async complete(request) {
        calls += 1;
        const column = request.bundle?.schemas.ListingColumnMappingColumn;
        const fieldType = column?.fields.find((f) => f.name === "field")?.type;
        sawEnum = fieldType?.kind === "enum" ? fieldType.values : undefined;
        expect(request.userInput).toContain("1. Property");
        return {
          data: {
            columns: [
              { column: "Property", field: "name", transform: null, confidence: "high" },
              { column: "Type", field: "kind", transform: null, confidence: "medium" },
              { column: "Guests", field: "sleeps", transform: null, confidence: "high" },
              { column: "Rate (EUR)", field: "nightlyRate", transform: "plain number, euros", confidence: "high" },
              { column: "Pets?", field: "petsAllowed", transform: "yes/no to boolean", confidence: "high" },
              { column: "Features", field: "amenities", transform: "split on ';'", confidence: "high" },
              { column: "Street", field: "address.street", transform: null, confidence: "high" },
              { column: "Town", field: "address.city", transform: null, confidence: "high" },
              { column: "Postcode", field: "address.zip", transform: null, confidence: "high" },
              { column: "Notes", field: null, transform: null, confidence: null },
            ],
          },
        };
      },
    };

    const schema = mappingSchema(Listing);
    const mapping = await coerce<ColumnMapping>(await mappingInput(listingsCsv), { provider, schema });
    expect(sawEnum).toContain("address.city");
    expect(mapping.columns).toHaveLength(10);
    expect(mapping.columns[9].field).toBeNull();

    const rows = applyMapping(await parseTable(listingsCsv), mapping, { schema: Listing });
    expect(calls).toBe(1);
    expect(rows.map((r) => r.name)).toEqual(["Sea Cabin", "Alfama Flat, top floor", "The Barn", "Lake House"]);
    expect(rows[3]).toMatchObject({ sleeps: 8, nightlyRate: 420, petsAllowed: false, address: { city: "Annecy", zip: "74000" } });
  });
});
