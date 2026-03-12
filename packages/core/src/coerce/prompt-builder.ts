import type { RuntimeSchema, FieldDescriptor, SchemaBundle } from "../schema/types.js";

/**
 * Build a semantic context block for a field, including nested schema context.
 */
function buildFieldContext(
  field: FieldDescriptor,
  parentPath: string,
  bundle: SchemaBundle | undefined,
  depth: number,
): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  const fieldPath = parentPath ? `${parentPath}.${field.name}` : field.name;

  lines.push(
    `${indent}- ${fieldPath} (${field.required ? "required" : "optional"}): ${field.description}`,
  );

  // If this is a nested object type, include nested schema context
  if (field.type.kind === "object" && bundle) {
    const nested = bundle.schemas[field.type.nestedSchemaId];
    if (nested) {
      lines.push(`${indent}  [${nested.id}: ${nested.description}]`);
      for (const nestedField of nested.fields) {
        lines.push(
          ...buildFieldContext(nestedField, fieldPath, bundle, depth + 1),
        );
      }
    }
  }

  // If this is an array of objects, include item schema context
  if (field.type.kind === "array" && field.type.items.kind === "object" && bundle) {
    const nested = bundle.schemas[field.type.items.nestedSchemaId];
    if (nested) {
      lines.push(`${indent}  [Array of ${nested.id}: ${nested.description}]`);
      for (const nestedField of nested.fields) {
        lines.push(
          ...buildFieldContext(nestedField, `${fieldPath}[]`, bundle, depth + 1),
        );
      }
    }
  }

  return lines;
}

/**
 * Build a system prompt that provides semantic context for the target schema.
 * This assembles the semantic hierarchy so the LLM understands the meaning
 * of each field in context.
 */
export function buildPrompt(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): string {
  const lines: string[] = [
    "You are a semantic coercion engine. Your task is to extract structured data from the user's input.",
    "",
    `Target schema: ${schema.id}`,
    `Description: ${schema.description}`,
    "",
    "Fields:",
  ];

  for (const field of schema.fields) {
    lines.push(...buildFieldContext(field, "", bundle, 0));
  }

  lines.push("");
  lines.push("Instructions:");
  lines.push("- Extract values from the user's input that match the schema fields.");
  lines.push("- Use null for optional fields that cannot be determined from the input.");
  lines.push("- Required fields must always have a valid, non-null value.");
  lines.push("- Interpret the user's input semantically — infer meaning, don't just pattern match.");
  lines.push("- Return only the structured JSON output matching the schema.");

  return lines.join("\n");
}
