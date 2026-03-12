import type { RuntimeSchema, SchemaBundle } from "@sembl/core";
import { toOpenAIJsonSchema } from "@sembl/core";
import type OpenAI from "openai";

type ResponseFormatJSONSchema =
  OpenAI.ChatCompletionCreateParams["response_format"] & { type: "json_schema" };

/**
 * Convert a RuntimeSchema to an OpenAI-compatible response_format parameter.
 * Applies OpenAI strict mode constraints:
 * - All properties in `required` array
 * - Optional fields use anyOf: [type, { type: "null" }]
 * - additionalProperties: false on every object
 * - Everything inlined (no $ref)
 */
export function toResponseFormat(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): ResponseFormatJSONSchema {
  const jsonSchema = toOpenAIJsonSchema(schema, bundle);

  return {
    type: "json_schema",
    json_schema: {
      name: schema.id,
      strict: true,
      schema: jsonSchema.schema as Record<string, unknown>,
    },
  } as ResponseFormatJSONSchema;
}
