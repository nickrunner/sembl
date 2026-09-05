import { bundleOf, defineSchema, field } from "@sembl/core";
import type { DefinedSchema, FieldDescriptor, FieldType, RuntimeSchema, SchemaBundle, TextSource } from "@sembl/core";
import { parseTable, tableRecords } from "./table.js";
import type { Table, TableData, TableOptions } from "./table.js";
import { tableText } from "./sources.js";

/**
 * Column mapping: the import-wizard problem. A spreadsheet arrives with
 * columns named however its author liked; the model reads the header row
 * and a few sample rows *once* and says which column feeds which field.
 * Code then applies that mapping to every row — no model call per row, no
 * drift between rows, and a mapping a person can review before the import
 * runs.
 */

/** How one column of a table feeds the target. */
export interface ColumnMap {
  /** The column's header, exactly as it appears in the table. */
  column: string;
  /**
   * The target field this column feeds, as a dotted path for a nested
   * field (`address.city`). Omitted or `null` when no field fits.
   */
  field?: string | null;
  /**
   * How to turn the cell into the field's value when it is not a direct
   * copy — a unit or currency conversion, a split on a separator, a date
   * format, a lookup. Omitted for a direct copy.
   */
  transform?: string | null;
  /** How sure the model is that this is the right field. */
  confidence?: "high" | "medium" | "low" | null;
}

/** What a mapping coercion returns: one entry per column of the table. */
export interface ColumnMapping {
  columns: ColumnMap[];
}

/** Options for {@link mappingSchema}. */
export interface MappingSchemaOptions {
  /**
   * The bundle holding the target's nested schemas, so that a nested
   * object's fields are offered as dotted paths. Defaults to the bundle a
   * `defineSchema` result carries; without one, nested objects are offered
   * whole.
   */
  bundle?: SchemaBundle;
  /** Id of the produced schema. Default `<target id>ColumnMapping`. */
  id?: string;
}

/** A field of the target a column may feed, flattened to a dotted path. */
export interface TargetField {
  /** Dotted path from the target's root. */
  path: string;
  /** The field's description, prefixed by its parents' where nested. */
  description: string;
  /** The leaf descriptor. */
  descriptor: FieldDescriptor;
}

function describeType(type: FieldType): string {
  switch (type.kind) {
    case "string":
    case "number":
    case "boolean":
      return type.kind;
    case "enum":
      return `one of ${type.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "dynamicEnum":
      return `a value from the "${type.sourceId}" taxonomy`;
    case "array":
      return `list of ${describeType(type.items)}`;
    case "object":
      return type.nestedSchemaId;
  }
}

/**
 * The fields of a target a column may feed, in schema order, with nested
 * objects flattened to dotted paths when their schema is in the bundle.
 * Arrays of objects are not flattened: a column cannot feed one element.
 */
export function targetFields(target: RuntimeSchema, bundle?: SchemaBundle): TargetField[] {
  const schemas = (bundle ?? bundleOf(target))?.schemas ?? {};
  const out: TargetField[] = [];
  const walk = (schema: RuntimeSchema, prefix: string, seen: readonly string[]) => {
    for (const descriptor of schema.fields) {
      const path = prefix ? `${prefix}.${descriptor.name}` : descriptor.name;
      const nested = descriptor.type.kind === "object" ? schemas[descriptor.type.nestedSchemaId] : undefined;
      if (nested && !seen.includes(nested.id)) {
        walk(nested, path, [...seen, nested.id]);
      } else {
        out.push({ path, description: `${descriptor.description} (${describeType(descriptor.type)})`, descriptor });
      }
    }
  };
  walk(target, "", [target.id]);
  return out;
}

/**
 * A schema for the mapping between a table's columns and the target's
 * fields, built from the target so that `field` is an enum of the target's
 * field paths and their descriptions are in the prompt. Coerce
 * {@link mappingInput} against it, then hand the result to
 * {@link applyMapping}.
 */
export function mappingSchema(target: RuntimeSchema, options: MappingSchemaOptions = {}): DefinedSchema<ColumnMapping> {
  const fields = targetFields(target, options.bundle);
  if (fields.length === 0) {
    throw new RangeError(`Schema "${target.id}" has no fields to map columns onto`);
  }
  const catalogue = fields.map((f) => `- ${f.path}: ${f.description}`).join("\n");

  const ColumnMapSchema = defineSchema(
    `${options.id ?? `${target.id}ColumnMapping`}Column`,
    "How one column of the table feeds the target.",
    {
      column: field.string("The column's header, exactly as written in the table."),
      field: field
        .enum(
          fields.map((f) => f.path),
          `The target field this column feeds. Leave it out when no field fits — never force a column onto a field it does not mean. The fields:\n${catalogue}`,
        )
        .optional(),
      transform: field
        .string(
          "How to turn the cell into the field's value when it is not a direct copy: a unit or currency conversion, a split on a separator, a date format, a lookup, a yes/no to boolean. Leave it out for a direct copy.",
          { maxLength: 200 },
        )
        .optional(),
      confidence: field.enum(["high", "medium", "low"], "How sure you are this is the right field.").optional(),
    },
  );

  return defineSchema(
    options.id ?? `${target.id}ColumnMapping`,
    `Which columns of a table feed which fields of ${target.id} (${target.description.trim().replace(/\.$/, "")}). One entry per column, in the table's column order, including columns that feed nothing.`,
    {
      columns: field.object(ColumnMapSchema, "One entry per column of the table, in column order.").array(),
    },
  ) as DefinedSchema<ColumnMapping>;
}

/** Options for {@link mappingText} and {@link mappingInput}. */
export interface MappingInputOptions {
  /** How many data rows to show under the headers. Default 5. */
  sampleRows?: number;
  /** Label for the source. Default: the sheet name, else `"Table sample"`. */
  label?: string;
}

/**
 * The header row and a few sample rows of a table as the text the mapping
 * is coerced from: the columns numbered, then the sample as an aligned
 * table, then how many rows the whole table has.
 */
export function mappingText(table: Table, options: MappingInputOptions = {}): string {
  const { sampleRows = 5 } = options;
  const sample: Table = {
    ...table,
    rows: table.rows.slice(0, sampleRows),
    rowNumbers: table.rowNumbers.slice(0, sampleRows),
    totalRows: Math.min(sampleRows, table.rows.length),
  };
  const columns = table.headers.map((h, i) => `${i + 1}. ${h}`).join("\n");
  const shown = sample.rows.length;
  return [
    `Columns (${table.headers.length}):\n${columns}`,
    `Sample rows (${shown} of ${table.totalRows}):\n${tableText(sample)}`,
  ].join("\n\n");
}

/**
 * Parse a table and render its header row plus a few sample rows as one
 * source, for coercing against {@link mappingSchema}.
 */
export async function mappingInput(data: TableData, options: TableOptions & MappingInputOptions = {}): Promise<TextSource> {
  const { sampleRows, label, ...tableOptions } = options;
  const table = await parseTable(data, tableOptions);
  const textOptions: MappingInputOptions = {};
  if (sampleRows !== undefined) textOptions.sampleRows = sampleRows;
  return { label: label ?? (table.name ? `${table.name} sample` : "Table sample"), text: mappingText(table, textOptions) };
}

/** Options for {@link applyMapping}. */
export interface ApplyMappingOptions {
  /**
   * The target schema. With it, cells are cast to the field's type where
   * the cast is unambiguous — numbers, booleans, enum values by
   * case-insensitive match, lists split on `;`, `|`, `,` or line breaks.
   * Without it every value stays a string.
   */
  schema?: RuntimeSchema;
  /** The bundle for nested fields; defaults to the one `schema` carries. */
  bundle?: SchemaBundle;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on", "x", "✓"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", "-", "—"]);

/** A number from a cell as people type them: thousands separators, currency signs, units. */
function parseNumber(text: string): number | undefined {
  const cleaned = text
    .replace(/[\s,€$£¥%]/g, "")
    .replace(/^[A-Za-z]{3}(?=[\d.-])/, "")
    .replace(/(?<=\d)[A-Za-z]{1,4}$/, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function splitList(text: string): string[] {
  const separator = /\r?\n/.test(text) ? /\r?\n/ : text.includes(";") ? ";" : text.includes("|") ? "|" : ",";
  return text.split(separator).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Cast a cell to a field's type when that is unambiguous; otherwise the string. */
export function castCell(text: string, type: FieldType): unknown {
  const trimmed = text.trim();
  switch (type.kind) {
    case "number":
      return parseNumber(trimmed) ?? trimmed;
    case "boolean": {
      const word = trimmed.toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      return trimmed;
    }
    case "enum": {
      const match = type.values.find((v) => v.toLowerCase() === trimmed.toLowerCase());
      return match ?? trimmed;
    }
    case "array":
      return splitList(trimmed).map((item) => castCell(item, type.items));
    default:
      return trimmed;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function normaliseKey(header: string): string {
  return header.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Apply a coerced mapping to every row, deterministically and without a
 * model: each mapped column's cell is copied into its field, blank cells
 * are left out, and a dotted field path builds the nested object. Column
 * names are matched exactly first, then ignoring case and surrounding
 * whitespace, since a model occasionally tidies a header. `transform`
 * hints are not executed — they are for a reviewer, or for a follow-up
 * per-row coercion of the columns that need one.
 */
export function applyMapping(
  rows: Table | readonly Record<string, string>[],
  mapping: ColumnMapping,
  options: ApplyMappingOptions = {},
): Record<string, unknown>[] {
  const records = Array.isArray(rows) ? rows : tableRecords(rows as Table);
  const types = new Map<string, FieldType>();
  if (options.schema) {
    for (const f of targetFields(options.schema, options.bundle)) types.set(f.path, f.descriptor.type);
  }
  const mapped = mapping.columns.filter((entry) => typeof entry.field === "string" && entry.field.length > 0);

  return records.map((record) => {
    const lookup = new Map(Object.keys(record).map((key) => [normaliseKey(key), key]));
    const result: Record<string, unknown> = {};
    for (const entry of mapped) {
      const key = entry.column in record ? entry.column : lookup.get(normaliseKey(entry.column));
      if (key === undefined) continue;
      const text = record[key] ?? "";
      if (text.trim() === "") continue;
      const path = entry.field as string;
      const type = types.get(path);
      setPath(result, path, type ? castCell(text, type) : text.trim());
    }
    return result;
  });
}
