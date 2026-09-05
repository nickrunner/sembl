import { coerce, coerceMany } from "@sembl/core";
import { applyMapping, mappingInput, mappingSchema, parseTable, tableRows } from "@sembl/source-table";
import type { ColumnMapping } from "@sembl/source-table";
import { Listing } from "../support/listing-runtime.js";
import { demoProvider, enumResolver, sample } from "../support/provider.js";
import { heading, note, ok, show, table } from "../support/print.js";

export const title = "@sembl/source-table: spreadsheet rows as a batch, and a column mapping applied without the model";

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const csv = sample("listings.csv");

  heading("Part 1 — rows as inputs: one source per row, coerced with coerceMany");
  const rows = await tableRows(csv, { label: "Listing" });
  note(`${rows.length} rows; each is rendered as Header: value lines so a row stands on its own.`);
  show(rows[0].label ?? "Row", rows[0].text);

  const results = await coerceMany<Partial<Listing>>(rows, {
    provider,
    schema: Listing,
    enumResolver,
    mode: "partialCoerce",
    onInvalidField: "clamp",
    concurrency: 3,
  });
  table(
    results.map((r) =>
      r.ok
        ? {
            row: rows[r.index].label,
            name: r.data.name,
            type: r.data.propertyType,
            sleeps: r.data.sleeps,
            rate: r.data.nightlyRate !== undefined ? `${r.data.nightlyRate} ${r.data.currency ?? ""}` : "",
            pets: r.data.petsAllowed,
            city: r.data.address?.city,
            amenities: (r.data.amenities ?? []).join(", "),
          }
        : { row: rows[r.index].label, name: `ERROR: ${(r.error as Error).message.split("\n")[0]}` },
    ),
  );
  ok(`${results.filter((r) => r.ok).length}/${results.length} rows coerced; ${results.length} model calls`);

  heading("Part 2 — column mapping: the model reads the headers once, code does every row");
  const schema = mappingSchema(Listing);
  const input = await mappingInput(csv, { sampleRows: 3 });
  note("mappingSchema(Listing) makes `field` an enum of the target's field paths, nested ones dotted:");
  const fieldEnum = schema.bundle.schemas[`${schema.id}Column`].fields.find((f) => f.name === "field")?.type;
  if (fieldEnum?.kind === "enum") note(`  ${fieldEnum.values.join(", ")}`);
  show(input.label ?? "Sample", input.text);

  const mapping = await coerce<ColumnMapping>(input, { provider, schema, enumResolver });
  table(
    mapping.columns.map((c) => ({
      column: c.column,
      field: c.field ?? "—",
      confidence: c.confidence ?? "",
      transform: c.transform ?? "",
    })),
  );

  const parsed = await parseTable(csv);
  const listings = applyMapping(parsed, mapping, { schema: Listing });
  note("applyMapping is pure: cells copied into fields, cast where the cast is unambiguous, no model call.");
  show("applyMapping(rows, mapping)[2]", listings[2]);
  const mapped = mapping.columns.filter((c) => c.field).length;
  ok(`${mapped} of ${mapping.columns.length} columns mapped in one call; ${listings.length} rows filled by code`);
  note("Columns with a transform hint are the ones a second, per-row pass (part 1) would earn its keep on.");
}
