import type { RuntimeSchema, ResolvedEnums, SchemaBundle } from "@sembl/core";
import { runtimeSchemaToJsonSchema } from "@sembl/core";

/** Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`. */
export function toToolName(schemaId: string): string {
  const cleaned = schemaId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 57);
  return `extract_${cleaned || "schema"}`.slice(0, 64);
}

/**
 * Convert a RuntimeSchema to an Anthropic tool `input_schema`.
 *
 * Unlike OpenAI structured outputs, Anthropic takes ordinary JSON Schema, so
 * optional fields are left out of `required` instead of being made nullable.
 * That keeps the model from inventing explicit `null`s for fields the source
 * text simply never mentioned — which matters for partial coercion, where an
 * absent field and a null field mean different things to the caller.
 */
export function toInputSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
  resolvedEnums?: ResolvedEnums,
): Record<string, unknown> {
  return runtimeSchemaToJsonSchema(schema, bundle, {
    dialect: "standard",
    resolvedEnums,
  });
}
