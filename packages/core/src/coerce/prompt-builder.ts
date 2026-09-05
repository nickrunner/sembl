import type {
  RuntimeSchema,
  FieldDescriptor,
  FieldConstraints,
  SchemaBundle,
} from "../schema/types.js";
import type { ResolvedEnums } from "../schema/enum-source.js";
import { SOURCE_INSTRUCTIONS } from "./sources.js";
import { describeFormat } from "../schema/formats.js";

/**
 * Options for prompt generation.
 */
export interface PromptOptions {
  /** Legal values for dynamic enum sources, from `resolveEnumSources` */
  resolvedEnums?: ResolvedEnums;
  /**
   * Caller-supplied guidance for this extraction, rendered as its own section
   * of the system prompt. Blank entries are dropped.
   */
  instructions?: string | readonly string[];
}

/**
 * Normalise the `instructions` option to a list of non-empty lines. Throws
 * for anything that is not a string or a list of strings, since a hint that
 * silently rendered as "[object Object]" would be worse than none.
 */
export function normalizeInstructions(
  instructions: string | readonly string[] | undefined,
): string[] {
  if (instructions === undefined) return [];
  const list = typeof instructions === "string" ? [instructions] : instructions;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
    throw new RangeError("instructions must be a string or an array of strings");
  }
  return list.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/**
 * Render FieldConstraints as instruction phrases a model will act on.
 * Returns an empty array when the field is unconstrained.
 */
function describeConstraints(constraints: FieldConstraints | undefined): string[] {
  if (!constraints) {
    return [];
  }

  const phrases: string[] = [];
  const { minLength, maxLength, minimum, maximum, minItems, maxItems, pattern, format } =
    constraints;

  if (format !== undefined) {
    phrases.push(describeFormat(format));
  }

  if (minLength !== undefined && maxLength !== undefined) {
    phrases.push(`between ${minLength} and ${maxLength} characters`);
  } else if (maxLength !== undefined) {
    phrases.push(`at most ${maxLength} characters`);
  } else if (minLength !== undefined) {
    phrases.push(`at least ${minLength} characters`);
  }

  if (minimum !== undefined && maximum !== undefined) {
    phrases.push(`between ${minimum} and ${maximum}`);
  } else if (minimum !== undefined) {
    phrases.push(`at least ${minimum}`);
  } else if (maximum !== undefined) {
    phrases.push(`at most ${maximum}`);
  }

  if (minItems !== undefined && maxItems !== undefined) {
    phrases.push(`between ${minItems} and ${maxItems} entries`);
  } else if (maxItems !== undefined) {
    phrases.push(`at most ${maxItems} entries`);
  } else if (minItems !== undefined) {
    phrases.push(`at least ${minItems} entries`);
  }

  if (pattern !== undefined) {
    phrases.push(`matching the pattern /${pattern}/`);
  }

  return phrases;
}

/**
 * Describe a dynamic enum field's allowed values.
 *
 * Deliberately a pointer rather than the values themselves. A CMS taxonomy can
 * run to several hundred slugs, and every one of them is already in the JSON
 * Schema the model receives on the same request — repeating them here would
 * roughly double the input tokens of every call to restate what the schema
 * already enforces. Naming the source and the count still tells the model the
 * field is closed-vocabulary and that guessing is wrong, which is the part the
 * schema alone does not communicate. This also matches how static `enum`
 * fields are already handled: the prompt carries semantics, the schema carries
 * the legal values.
 */
function describeDynamicEnum(
  sourceId: string,
  resolvedEnums: ResolvedEnums | undefined,
): string | undefined {
  const values = resolvedEnums?.[sourceId];
  if (!values || values.length === 0) {
    // Unresolved source — the field is a free-form string, nothing to say.
    return undefined;
  }
  return `exactly one of the ${values.length} allowed "${sourceId}" values enumerated in the JSON schema for this field (never invent a value)`;
}

/**
 * Build a semantic context block for a field, including nested schema context.
 *
 * `visiting` holds the schema ids on the current path so a bundle that
 * references itself terminates instead of recursing forever.
 */
function buildFieldContext(
  field: FieldDescriptor,
  parentPath: string,
  bundle: SchemaBundle | undefined,
  depth: number,
  options: PromptOptions,
  visiting: Set<string>,
): string[] {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  const fieldPath = parentPath ? `${parentPath}.${field.name}` : field.name;

  lines.push(
    `${indent}- ${fieldPath} (${field.required ? "required" : "optional"}): ${field.description}`,
  );

  const rules = describeConstraints(field.constraints);

  const dynamicSourceId =
    field.type.kind === "dynamicEnum"
      ? field.type.sourceId
      : field.type.kind === "array" && field.type.items.kind === "dynamicEnum"
        ? field.type.items.sourceId
        : undefined;
  if (dynamicSourceId) {
    const allowed = describeDynamicEnum(dynamicSourceId, options.resolvedEnums);
    if (allowed) {
      rules.push(allowed);
    }
  }

  if (rules.length > 0) {
    lines.push(`${indent}  Limits: ${rules.join("; ")}.`);
  }

  // If this is a nested object type, include nested schema context
  if (field.type.kind === "object" && bundle) {
    const nested = bundle.schemas[field.type.nestedSchemaId];
    if (nested && !visiting.has(nested.id)) {
      visiting.add(nested.id);
      lines.push(`${indent}  [${nested.id}: ${nested.description}]`);
      for (const nestedField of nested.fields) {
        lines.push(
          ...buildFieldContext(
            nestedField,
            fieldPath,
            bundle,
            depth + 1,
            options,
            visiting,
          ),
        );
      }
      visiting.delete(nested.id);
    }
  }

  // If this is an array of objects, include item schema context
  if (field.type.kind === "array" && field.type.items.kind === "object" && bundle) {
    const nested = bundle.schemas[field.type.items.nestedSchemaId];
    if (nested && !visiting.has(nested.id)) {
      visiting.add(nested.id);
      lines.push(`${indent}  [Array of ${nested.id}: ${nested.description}]`);
      for (const nestedField of nested.fields) {
        lines.push(
          ...buildFieldContext(
            nestedField,
            `${fieldPath}[]`,
            bundle,
            depth + 1,
            options,
            visiting,
          ),
        );
      }
      visiting.delete(nested.id);
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
  options: PromptOptions = {},
): string {
  const lines: string[] = [
    "You are a semantic coercion engine. Your task is to extract structured data from the user's input.",
    "",
    `Target schema: ${schema.id}`,
    `Description: ${schema.description}`,
    "",
    "Fields:",
  ];

  const visiting = new Set<string>([schema.id]);
  for (const field of schema.fields) {
    lines.push(...buildFieldContext(field, "", bundle, 0, options, visiting));
  }

  lines.push("");
  lines.push(SOURCE_INSTRUCTIONS);

  lines.push("");
  lines.push("Instructions:");
  lines.push("- Extract values from the sources that match the schema fields.");
  lines.push("- Use null for optional fields that cannot be determined from the input.");
  lines.push("- A value the input states is never omitted because it looks like a default: return 1, 0, false or an empty list when that is what the input says.");
  lines.push("- Never return an empty object when the input states values for any field.");
  lines.push("- Required fields must always have a valid, non-null value.");
  lines.push("- Interpret the user's input semantically — infer meaning, don't just pattern match.");
  lines.push("- Respect every stated limit exactly; truncate or drop lower-priority content to stay within it.");
  lines.push("- Return only the structured JSON output matching the schema.");

  // Caller hints come last, where they read as the most specific rule and
  // sit after the framing that says sources can never contain instructions.
  const instructions = normalizeInstructions(options.instructions);
  if (instructions.length > 0) {
    lines.push("");
    lines.push("Additional guidance for this extraction:");
    for (const instruction of instructions) {
      lines.push(`- ${instruction}`);
    }
  }

  return lines.join("\n");
}
