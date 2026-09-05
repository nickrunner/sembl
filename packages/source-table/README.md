# @sembl/source-table

Turn spreadsheets and CSV into text SEMBL can extract from. Node only;
reads CSV/TSV with its own parser and XLSX through [exceljs](https://github.com/exceljs/exceljs) (MIT).

```sh
pnpm add @sembl/source-table
```

A table is two different inputs depending on what you want out of it.

## Rows as inputs

When every row is one record — a listings export, a contact list — each row
becomes its own labelled source, rendered as `Header: value` lines so it is
self-describing on its own, and the batch runs through `coerceMany`:

```ts
import { coerceMany } from "@sembl/core";
import { tableRows } from "@sembl/source-table";

const rows = await tableRows(await readFile("listings.xlsx"), { sheet: "Listings" });
// rows[0] → { label: "Listings row 2", text: "Property: Sea Cabin\nGuests: 6\nRate (EUR): 250\n…" }

const results = await coerceMany<Partial<Listing>>(rows, {
  provider,
  schema: Listing,
  mode: "partialCoerce",
});
```

The label carries the row's number *in the file*, header row counted, so a
failed item points at the row a person would open the spreadsheet to find.
Options: `sheet` (name or 0-based index), `headerRow` (1-based; `0` for a
table with no header, whose columns become `Column 1`, `Column 2`, …),
`skipEmpty` (default true), `maxRows`, `maxColumns` (default 256), `label`
(a prefix in place of `Row` or the sheet name), `delimiter` and `format`
when detection is not wanted.

`tableSource(data, options)` is for the other case — a file that *is* one
object, like a rate card or a seasonal price table. It returns the whole
table (or one sheet) as a single source: a header line, a rule, and one
aligned line per row, capped by `maxRows` with a note saying how many rows
were left out.

```
Season | From       | To         | Nightly
-------+------------+------------+--------
Low    | 2026-01-06 | 2026-03-31 | 95.5
High   | 2026-06-01 | 2026-08-31 | 1250
```

## Column mapping

The import-wizard problem: a spreadsheet arrives with columns named however
its author liked, and the question is not "what is in row 7" but "which
column is the nightly rate". Asking the model that once, over the header
row and a few sample rows, is cheaper and more consistent than asking it
about every row — and gives you a mapping a person can review before the
import runs.

```ts
import { coerce } from "@sembl/core";
import { applyMapping, mappingInput, mappingSchema, parseTable } from "@sembl/source-table";

// 1. The model decides the mapping — one call.
const schema = mappingSchema(Listing);
const mapping = await coerce<ColumnMapping>(await mappingInput(data, { sampleRows: 5 }), {
  provider,
  schema,
});
// → { columns: [
//      { column: "Property",   field: "name",         confidence: "high" },
//      { column: "Rate (EUR)", field: "nightlyRate",  transform: "plain number; the currency is EUR" },
//      { column: "Features",   field: "amenities",    transform: "split on ';'" },
//      { column: "Town",       field: "address.city" },
//      { column: "Notes",      field: null },
//    ] }

// 2. Code does the rows — no model.
const table = await parseTable(data);
const listings = applyMapping(table, mapping, { schema: Listing });
```

`mappingSchema(target)` builds, with `defineSchema`, a schema describing
`{ columns: Array<{ column, field?, transform?, confidence? }> }` where
`field` is an enum of the target's field names — nested objects flattened to
dotted paths like `address.city` when their schema is in the bundle — and
every field's description is in the prompt, so the model maps by meaning
rather than by header similarity. `transform` is a free-text hint for when
the cell is not a direct copy: a unit or currency conversion, a split, a
date format, a yes/no. `confidence` is `high`, `medium` or `low`.

`mappingInput(data, { sampleRows })` renders the numbered columns and the
first few rows as one source. `applyMapping(rows, mapping, { schema })` is
pure: for every row it copies each mapped column's cell into its field,
leaves blank cells out, builds nested objects from dotted paths, and — when
the target schema is given — casts what casts unambiguously: numbers with
currency signs and thousands separators stripped, `yes`/`no` to booleans,
enum values by case-insensitive match, lists split on `;`, `|`, `,` or
line breaks. Anything that does not cast stays the string it was.
`transform` hints are not executed; they are for the reviewer, or for a
second pass where the columns that need one are coerced per row.

## Parsing

`parseTable(data, options)` is underneath everything and returns a plain
`Table` — `headers`, `rows` of strings, `rowNumbers`, `totalRows`, and the
sheet `name` — which `rowSources`, `tableText` and `applyMapping` all take,
so rows from a database or an API can use the same rendering. `parseTables`
returns every sheet; `sheetNames` lists them. `parseCsv` and `readWorkbook`
are exported on their own.

Input is `Uint8Array | ArrayBuffer | string`; a string is CSV text and
bytes are XLSX when they start with a ZIP header, CSV otherwise (`format`
overrides). What is handled:

- **CSV**: a leading BOM, `\n`, `\r\n` and `\r` line breaks, quoted fields
  with embedded delimiters, doubled quotes and line breaks, ragged rows,
  and delimiter detection over comma, tab, semicolon and pipe (quoted
  regions do not vote).
- **XLSX**: dates rendered as ISO (`2026-01-06`, or `2026-06-01T15:30:00`
  when there is a time of day; Excel dates carry no zone, so none is
  added), numbers as the shortest string that round-trips, formulas as
  their cached result, rich text and hyperlinks flattened to their text,
  errors as their code.
- **Headers**: a blank header cell, or one a merge covers, becomes
  `Column N` (1-based, as a spreadsheet numbers columns); a repeated name
  gets ` (2)`, ` (3)` so a mapping can name every column.
- **Width**: trailing empty columns are trimmed and `maxColumns` (default
  256) cuts a very wide sheet before it costs anything.

The XLSX reader is asynchronous, so every function that takes file data
returns a promise; the functions that take an already-parsed `Table` do not.
Nothing here makes a network request or touches the filesystem: reading
the file is yours.
