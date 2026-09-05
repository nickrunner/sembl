import { formatToJsonSchema } from "./formats.js";
import type {
  RuntimeSchema,
  FieldDescriptor,
  FieldConstraints,
  FieldType,
  SchemaBundle,
} from "./types.js";
import type { ResolvedEnums } from "./enum-source.js";

type JsonSchema = Record<string, unknown>;

/**
 * Which flavour of JSON Schema to emit.
 *
 * - `"openai-strict"` — the subset OpenAI structured outputs accepts.
 * - `"standard"` — ordinary JSON Schema, for validators and other providers.
 */
export type JsonSchemaDialect = "openai-strict" | "standard";

/**
 * Options for JSON Schema generation.
 */
export interface JsonSchemaOptions {
  /** Legal values for dynamic enum sources, from `resolveEnumSources` */
  resolvedEnums?: ResolvedEnums;
  /** Target dialect. Defaults to `"openai-strict"`. */
  dialect?: JsonSchemaDialect;
}

/**
 * Keys of FieldConstraints that map 1:1 onto JSON Schema keywords.
 *
 * These are emitted in the `"standard"` dialect only, and deliberately dropped
 * under `"openai-strict"`. OpenAI's structured outputs validate the schema up
 * front and reject the whole request on an unsupported keyword — errors read
 * like `'minLength' is not permitted` — so emitting one turns a soft
 * constraint into a hard 400. Reports on which of these the strict validator
 * accepts currently conflict: multiple 2026 tool integrations still strip all
 * of them, while OpenAI has announced incremental support for string lengths,
 * patterns, numeric ranges and array bounds. The primary documentation was
 * unreachable when this was written, so the conservative branch wins.
 *
 * Nothing is actually lost: the prompt states every constraint and the
 * validator enforces every constraint, so dropping them here costs only
 * schema-level enforcement. To loosen this, confirm against the current
 * structured-outputs docs (the "Supported properties" / unsupported-keyword
 * list) which keywords the strict validator accepts for the models in use,
 * then move those into the strict branch.
 */
const CONSTRAINT_KEYWORDS = [
  "maxLength",
  "minLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "pattern",
] as const satisfies readonly (keyof FieldConstraints)[];

/** The subset of CONSTRAINT_KEYWORDS that bounds an array rather than a value. */
const ARRAY_KEYWORDS: readonly string[] = ["minItems", "maxItems"];

/**
 * Translate FieldConstraints into JSON Schema keywords for the given dialect.
 */
function constraintsToJsonSchema(
  constraints: FieldConstraints | undefined,
  dialect: JsonSchemaDialect,
): JsonSchema {
  if (!constraints || dialect === "openai-strict") {
    return {};
  }

  const out: JsonSchema = {};
  if (constraints.format !== undefined) {
    Object.assign(out, formatToJsonSchema(constraints.format));
  }
  for (const keyword of CONSTRAINT_KEYWORDS) {
    const value = constraints[keyword];
    if (value !== undefined) {
      out[keyword] = value;
    }
  }
  return out;
}

/**
 * Convert a FieldType to a JSON Schema type definition.
 *
 * `visiting` holds the schema ids on the current inlining path so a bundle
 * that references itself terminates instead of recursing forever.
 */
function fieldTypeToJsonSchema(
  fieldType: FieldType,
  bundle: SchemaBundle | undefined,
  options: JsonSchemaOptions,
  visiting: Set<string>,
): JsonSchema {
  switch (fieldType.kind) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array":
      return {
        type: "array",
        items: fieldTypeToJsonSchema(fieldType.items, bundle, options, visiting),
      };
    case "enum":
      return { type: "string", enum: fieldType.values };
    case "dynamicEnum": {
      const values = options.resolvedEnums?.[fieldType.sourceId];
      // An unresolved source can only be expressed as a free-form string.
      return values && values.length > 0
        ? { type: "string", enum: [...values] }
        : { type: "string" };
    }
    case "object": {
      // If we have a bundle and can find the nested schema, inline it
      const nested = bundle?.schemas[fieldType.nestedSchemaId];
      if (nested && !visiting.has(nested.id)) {
        return buildObjectSchema(nested, bundle, options, visiting);
      }
      return { type: "object", additionalProperties: false };
    }
  }
}

/**
 * Convert a FieldDescriptor to a JSON Schema property definition.
 */
function fieldToJsonSchema(
  field: FieldDescriptor,
  bundle: SchemaBundle | undefined,
  options: JsonSchemaOptions,
  visiting: Set<string>,
): JsonSchema {
  const base = fieldTypeToJsonSchema(field.type, bundle, options, visiting);
  const dialect = options.dialect ?? "openai-strict";
  const constraints = constraintsToJsonSchema(field.constraints, dialect);

  if (base.type !== "array") {
    return { ...base, ...constraints, description: field.description };
  }

  // On an array field only minItems/maxItems bound the array; the string and
  // number bounds describe each element, so they move onto `items`.
  const arrayLevel: JsonSchema = {};
  const itemLevel: JsonSchema = {};
  for (const [keyword, value] of Object.entries(constraints)) {
    (ARRAY_KEYWORDS.includes(keyword) ? arrayLevel : itemLevel)[keyword] = value;
  }

  return {
    ...base,
    ...arrayLevel,
    items: { ...(base.items as JsonSchema), ...itemLevel },
    description: field.description,
  };
}

/**
 * Build the object schema for a RuntimeSchema, tracking the inlining path.
 */
function buildObjectSchema(
  schema: RuntimeSchema,
  bundle: SchemaBundle | undefined,
  options: JsonSchemaOptions,
  visiting: Set<string>,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const dialect = options.dialect ?? "openai-strict";

  visiting.add(schema.id);
  for (const field of schema.fields) {
    const fieldSchema = fieldToJsonSchema(field, bundle, options, visiting);

    if (dialect === "openai-strict") {
      // Strict mode admits no absent property, so an optional field is
      // expressed as a nullable one and every name goes in `required`.
      properties[field.name] = field.required
        ? fieldSchema
        : { anyOf: [fieldSchema, { type: "null" }] };
      required.push(field.name);
    } else {
      properties[field.name] = fieldSchema;
      if (field.required) {
        required.push(field.name);
      }
    }
  }
  visiting.delete(schema.id);

  return {
    type: "object",
    description: schema.description,
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Convert a RuntimeSchema to a JSON Schema object.
 *
 * Under `"openai-strict"`, every property is listed in `required` and an
 * optional field becomes `anyOf: [T, null]`, as structured outputs demand.
 * Under `"standard"`, only genuinely required fields are listed and optional
 * ones are simply absent — which is what keeps an unmentioned field
 * distinguishable from one the model explicitly nulled.
 *
 * Both dialects inline nested schemas (no `$ref`) and set
 * `additionalProperties: false`. Dynamic enum fields become a string `enum`
 * when their source resolved, and a plain string otherwise. FieldConstraints
 * are emitted only in `"standard"` — see {@link CONSTRAINT_KEYWORDS}.
 */
export function runtimeSchemaToJsonSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
  options: JsonSchemaOptions = {},
): JsonSchema {
  return buildObjectSchema(schema, bundle, options, new Set());
}

/**
 * Wrap a RuntimeSchema as a top-level JSON Schema suitable for
 * OpenAI's response_format.json_schema.schema parameter.
 */
export function toOpenAIJsonSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
  options: Omit<JsonSchemaOptions, "dialect"> = {},
): JsonSchema {
  return {
    name: schema.id,
    strict: true,
    schema: runtimeSchemaToJsonSchema(schema, bundle, {
      ...options,
      dialect: "openai-strict",
    }),
  };
}
