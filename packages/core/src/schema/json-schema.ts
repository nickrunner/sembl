import type { RuntimeSchema, FieldDescriptor, FieldType, SchemaBundle } from "./types.js";
import type { ResolvedEnums } from "./enum-source.js";

type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema flavour to emit.
 *
 * - `"openai-strict"` — OpenAI structured-output constraints: every property
 *   listed in `required`, optional fields expressed as `anyOf: [T, null]`.
 * - `"standard"` — ordinary JSON Schema: only genuinely required fields are
 *   listed in `required`, optional fields are simply omitted from it. This is
 *   what Anthropic tool `input_schema` (and most other consumers) expect.
 *
 * Both flavours inline nested schemas (no `$ref`) and set
 * `additionalProperties: false`.
 */
export type JsonSchemaDialect = "openai-strict" | "standard";

export interface JsonSchemaOptions {
  /** Defaults to `"openai-strict"` for backwards compatibility. */
  dialect?: JsonSchemaDialect;
  /**
   * Legal values for `dynamicEnum` sources, keyed by `sourceId`. A source with
   * no entry here is emitted as an unconstrained string.
   */
  resolvedEnums?: ResolvedEnums;
}

/**
 * Convert a FieldType to a JSON Schema type definition.
 */
function fieldTypeToJsonSchema(
  fieldType: FieldType,
  bundle: SchemaBundle | undefined,
  dialect: JsonSchemaDialect,
  resolvedEnums: ResolvedEnums | undefined,
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
        items: fieldTypeToJsonSchema(fieldType.items, bundle, dialect, resolvedEnums),
      };
    case "enum":
      return { type: "string", enum: fieldType.values };
    case "dynamicEnum": {
      const values = resolvedEnums?.[fieldType.sourceId];
      // An unresolved source stays an unconstrained string rather than an
      // empty enum, which no value could satisfy.
      return values && values.length > 0
        ? { type: "string", enum: [...values] }
        : { type: "string" };
    }
    case "object": {
      // If we have a bundle and can find the nested schema, inline it
      if (bundle && bundle.schemas[fieldType.nestedSchemaId]) {
        return runtimeSchemaToJsonSchema(
          bundle.schemas[fieldType.nestedSchemaId],
          bundle,
          { dialect, resolvedEnums },
        );
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
  dialect: JsonSchemaDialect,
  resolvedEnums: ResolvedEnums | undefined,
): JsonSchema {
  const base = fieldTypeToJsonSchema(field.type, bundle, dialect, resolvedEnums);
  return {
    ...base,
    description: field.description,
  };
}

/**
 * Convert a RuntimeSchema to a JSON Schema object.
 *
 * The shape depends on {@link JsonSchemaDialect}; see its docs. Nested schemas
 * are always inlined (no `$ref`) and every object gets
 * `additionalProperties: false`.
 */
export function runtimeSchemaToJsonSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
  options?: JsonSchemaOptions,
): JsonSchema {
  const dialect = options?.dialect ?? "openai-strict";
  const resolvedEnums = options?.resolvedEnums;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const field of schema.fields) {
    const fieldSchema = fieldToJsonSchema(field, bundle, dialect, resolvedEnums);

    if (dialect === "openai-strict") {
      // Optional fields are nullable rather than absent, and ALL properties
      // must appear in `required`.
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

  return {
    type: "object",
    description: schema.description,
    properties,
    required,
    additionalProperties: false,
  };
}

/**
 * Wrap a RuntimeSchema as a top-level JSON Schema suitable for
 * OpenAI's response_format.json_schema.schema parameter.
 */
export function toOpenAIJsonSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
  resolvedEnums?: ResolvedEnums,
): JsonSchema {
  return {
    name: schema.id,
    strict: true,
    schema: runtimeSchemaToJsonSchema(schema, bundle, {
      dialect: "openai-strict",
      resolvedEnums,
    }),
  };
}
