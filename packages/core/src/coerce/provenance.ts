import type {
  FieldDescriptor,
  RuntimeSchema,
  SchemaBundle,
} from "../schema/types.js";

/**
 * How well the input supported a value.
 *
 * A three-level scale rather than a number: models are poorly calibrated at
 * producing a 0–1 score, and a review UI only ever needs to decide whether to
 * flag a field for a human anyway.
 */
export type FieldConfidence = "high" | "medium" | "low";

/** Where a coerced field's value came from. */
export interface FieldProvenance {
  /** How well the input supported this value. */
  confidence: FieldConfidence;
  /**
   * The span of input the value was read from, quoted. Absent when the value
   * was inferred rather than read — which is itself the signal worth showing.
   */
  evidence?: string;
}

/** A coercion result paired with per-field provenance. */
export interface ProvenanceResult<T> {
  /** The coerced data, in the shape of the target schema. */
  data: T;
  /** Provenance for each top-level field the model returned, keyed by name. */
  provenance: Record<string, FieldProvenance>;
}

/** Suffix marking the wrapper schema built around a target schema. */
const WRAPPER_SUFFIX = "__WithProvenance";

/** Suffix marking the per-field annotation schema. */
const ANNOTATION_SUFFIX = "__Annotated";

const CONFIDENCE_VALUES: FieldConfidence[] = ["high", "medium", "low"];

/**
 * Extra prompt guidance for a provenance run.
 *
 * The JSON Schema already forces the shape; what it cannot convey is how to
 * judge confidence, which is the whole point of asking.
 */
export const PROVENANCE_INSTRUCTIONS = [
  "",
  "Provenance:",
  "- Every field is wrapped as an object: put the extracted value in `value`.",
  "- Set `confidence` to how well the input supports that value:",
  '  "high" — stated outright in the input;',
  '  "medium" — strongly implied, but not stated;',
  '  "low" — a guess from weak or indirect signals.',
  "- Set `evidence` to the shortest quote from the input the value came from.",
  "  Leave `evidence` out when you inferred the value rather than reading it —",
  "  do not quote text that does not actually contain it.",
  "- Judge each field on its own. A confident value next to a guessed one is",
  "  normal, and marking the guess honestly is more useful than looking sure.",
].join("\n");

/**
 * Build the annotation schema wrapping one field's value.
 */
function annotationSchema(
  parentId: string,
  field: FieldDescriptor,
): RuntimeSchema {
  const valueField: FieldDescriptor = {
    name: "value",
    description: field.description,
    type: field.type,
    required: true,
    ...(field.constraints !== undefined ? { constraints: field.constraints } : {}),
  };

  return {
    id: `${parentId}__${field.name}${ANNOTATION_SUFFIX}`,
    description: `The extracted value for "${field.name}", with where it came from.`,
    fields: [
      valueField,
      {
        name: "confidence",
        description: "How well the input supported this value.",
        type: { kind: "enum", values: [...CONFIDENCE_VALUES] },
        required: true,
      },
      {
        name: "evidence",
        description:
          "The shortest quote from the input this value was read from. Omit when the value was inferred rather than read.",
        type: { kind: "string" },
        required: false,
      },
    ],
  };
}

/**
 * Derive the schema to actually request when provenance is wanted: the same
 * fields, each wrapped in `{ value, confidence, evidence }`.
 *
 * Only top-level fields are annotated. A nested object keeps its ordinary
 * shape inside `value`, so provenance is reported for the object as a whole
 * rather than per leaf — annotating every leaf multiplies both the schema and
 * the output for detail a review UI rarely acts on.
 *
 * Returns a bundle carrying the wrapper, the per-field annotation schemas, and
 * everything the original bundle held, so nested types still inline.
 */
export function toProvenanceSchema(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): { schema: RuntimeSchema; bundle: SchemaBundle } {
  const schemas: Record<string, RuntimeSchema> = { ...(bundle?.schemas ?? {}) };
  const fields: FieldDescriptor[] = [];

  for (const field of schema.fields) {
    const annotation = annotationSchema(schema.id, field);
    schemas[annotation.id] = annotation;
    fields.push({
      name: field.name,
      description: field.description,
      type: { kind: "object", nestedSchemaId: annotation.id },
      required: field.required,
    });
  }

  const wrapper: RuntimeSchema = {
    id: `${schema.id}${WRAPPER_SUFFIX}`,
    description: schema.description,
    fields,
  };
  schemas[wrapper.id] = wrapper;

  return { schema: wrapper, bundle: { schemas } };
}

function isConfidence(value: unknown): value is FieldConfidence {
  return CONFIDENCE_VALUES.includes(value as FieldConfidence);
}

/**
 * Split a provenance-shaped response back into plain data and per-field
 * provenance.
 *
 * A field the model returned unwrapped — or wrapped without a usable
 * `confidence` — still yields its value; the provenance is simply not
 * recorded. Losing an annotation is not a reason to lose the extraction, and
 * the missing key is visible to the caller.
 */
export function splitProvenance(
  response: Record<string, unknown>,
  schema: RuntimeSchema,
): { data: Record<string, unknown>; provenance: Record<string, FieldProvenance> } {
  const data: Record<string, unknown> = {};
  const provenance: Record<string, FieldProvenance> = {};

  for (const field of schema.fields) {
    const annotated = response[field.name];
    if (annotated === undefined || annotated === null) {
      data[field.name] = annotated ?? null;
      continue;
    }

    if (typeof annotated !== "object" || Array.isArray(annotated) || !("value" in annotated)) {
      data[field.name] = annotated;
      continue;
    }

    const record = annotated as Record<string, unknown>;
    data[field.name] = record.value ?? null;

    if (isConfidence(record.confidence)) {
      const evidence = record.evidence;
      provenance[field.name] = {
        confidence: record.confidence,
        ...(typeof evidence === "string" && evidence.length > 0 ? { evidence } : {}),
      };
    }
  }

  return { data, provenance };
}
