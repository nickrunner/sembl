import type { RuntimeSchema, FieldDescriptor, FieldType, SchemaBundle } from "./types.js";

type JsonSchema = Record<string, unknown>;

/**
 * Convert a FieldType to a JSON Schema type definition.
 */
function fieldTypeToJsonSchema(
  fieldType: FieldType,
  bundle?: SchemaBundle,
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
        items: fieldTypeToJsonSchema(fieldType.items, bundle),
      };
    case "enum":
      return { type: "string", enum: fieldType.values };
    case "object": {
      // If we have a bundle and can find the nested schema, inline it
      if (bundle && bundle.schemas[fieldType.nestedSchemaId]) {
        return runtimeSchemaToJsonSchema(
          bundle.schemas[fieldType.nestedSchemaId],
          bundle,
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
  bundle?: SchemaBundle,
): JsonSchema {
  const base = fieldTypeToJsonSchema(field.type, bundle);
  return {
    ...base,
    description: field.description,
  };
}

/**
 * Convert a RuntimeSchema to a JSON Schema object.
 * Follows OpenAI strict mode constraints:
 * - All properties in `required` array
 * - Optional fields use anyOf: [type, { type: "null" }]
 * - additionalProperties: false on every object
 * - Everything inlined (no $ref)
 */
export function runtimeSchemaToJsonSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const field of schema.fields) {
    const fieldSchema = fieldToJsonSchema(field, bundle);

    if (field.required) {
      properties[field.name] = fieldSchema;
    } else {
      // OpenAI strict mode: optional fields use anyOf with null
      properties[field.name] = {
        anyOf: [fieldSchema, { type: "null" }],
      };
    }

    // OpenAI strict mode: ALL properties must be in required
    required.push(field.name);
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
): JsonSchema {
  return {
    name: schema.id,
    strict: true,
    schema: runtimeSchemaToJsonSchema(schema, bundle),
  };
}
