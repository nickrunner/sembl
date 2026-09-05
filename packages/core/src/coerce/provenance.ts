import type {
  FieldDescriptor,
  RuntimeSchema,
  SchemaBundle,
} from "../schema/types.js";
import type { ResolvedIssue } from "./resolve-issues.js";
import type { CoerceUsage } from "./coerce.js";
import type { SourceKind } from "./sources.js";

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
   * The span of input the value was read from, quoted — or, for a value read
   * from an image, a short description of where in the image it appears.
   * Absent when the value was inferred rather than read — which is itself
   * the signal worth showing.
   */
  evidence?: string;
  /**
   * The label of the source the value was read from. Only present when the
   * coercion was given more than one source.
   */
  source?: string;
}

/** A coercion result paired with per-field provenance. */
export interface ProvenanceResult<T> {
  /** The coerced data, in the shape of the target schema. */
  data: T;
  /** Provenance for each top-level field the model returned, keyed by name. */
  provenance: Record<string, FieldProvenance>;
  /**
   * Validation issues the `onInvalidField` policy absorbed instead of
   * throwing — each with what was dropped or clamped. Empty under the
   * default `"throw"` policy, or when the response validated cleanly.
   */
  issues: ResolvedIssue[];
  /** Token usage summed over every call the coercion made. */
  usage: CoerceUsage;
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
 * The evidence rule for values read from an image or a document, added to
 * {@link PROVENANCE_INSTRUCTIONS} only when a run has such a source: a
 * photo has nothing to quote, so the evidence says where to look instead.
 */
export const BINARY_PROVENANCE_INSTRUCTIONS = [
  "- For a value read from an image, `evidence` is a short description of where",
  '  in the image it appears — "the price on the sign above the door" — rather',
  "  than a quote. For a value read from a document, quote the page as usual",
  "  and lead with the page number when there are several.",
].join("\n");

/** The description of the `evidence` field in the annotation schema. */
const EVIDENCE_DESCRIPTION =
  "The shortest quote from the input this value was read from. Omit when the value was inferred rather than read.";
const BINARY_EVIDENCE_DESCRIPTION =
  "The shortest quote from the input this value was read from, or for an image a short description of where in it the value appears. Omit when the value was inferred rather than read.";

function hasBinary(kinds: readonly SourceKind[] | undefined): boolean {
  return kinds !== undefined && kinds.some((kind) => kind !== "text");
}

/** Options for {@link toProvenanceSchema} and {@link provenanceInstructions}. */
export interface ProvenanceOptions {
  /**
   * The kinds of source the coercion was given. When an image or a document
   * is among them, the evidence rule and the annotation schema say what
   * evidence means for a value with nothing to quote.
   */
  sourceKinds?: readonly SourceKind[];
  /**
   * Labels of the sources the coercion was given, when there are several.
   * Each annotation then also asks which source the value was read from.
   */
  sourceLabels?: readonly string[];
  /**
   * Only these top-level fields are wrapped; every other field comes back
   * as a plain value with no provenance. Halves the output on schemas where
   * a human reviews a handful of fields and code checks the rest. All
   * fields when absent.
   */
  fields?: readonly string[];
}

/**
 * The top-level fields provenance applies to, validated against the schema:
 * a name that is not a field is a typo that would otherwise silently drop
 * the wrapper the caller asked for.
 */
export function provenanceFieldNames(
  schema: RuntimeSchema,
  fields: readonly string[] | undefined,
): Set<string> {
  if (fields === undefined) return new Set(schema.fields.map((f) => f.name));
  const known = new Set(schema.fields.map((f) => f.name));
  for (const name of fields) {
    if (!known.has(name)) {
      throw new RangeError(
        `provenance field "${name}" is not a field of schema "${schema.id}" (fields: ${[...known].join(", ")})`,
      );
    }
  }
  return new Set(fields);
}

/**
 * The provenance guidance for a run, extended with the source rule when the
 * run has several sources to choose between.
 */
export function provenanceInstructions(options: ProvenanceOptions = {}): string {
  const labels = options.sourceLabels ?? [];
  let text = PROVENANCE_INSTRUCTIONS;
  if (options.fields !== undefined) {
    text = text.replace(
      "- Every field is wrapped as an object: put the extracted value in `value`.",
      `- Only these fields are wrapped as objects, with the extracted value in \`value\`: ${options.fields.join(", ")}. Every other field is a plain value.`,
    );
  }
  if (hasBinary(options.sourceKinds)) {
    text += `\n${BINARY_PROVENANCE_INSTRUCTIONS}`;
  }
  if (labels.length >= 2) {
    text += "\n- Always set `source` to the label of the source the value was read from. When several agree, name the one quoted in `evidence`.";
  }
  return text;
}

/**
 * Build the annotation schema wrapping one field's value.
 */
function annotationSchema(
  parentId: string,
  field: FieldDescriptor,
  sourceLabels: readonly string[],
  binary: boolean,
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
        description: binary ? BINARY_EVIDENCE_DESCRIPTION : EVIDENCE_DESCRIPTION,
        type: { kind: "string" },
        required: false,
      },
      ...(sourceLabels.length >= 2
        ? [
            {
              name: "source",
              description: "The label of the source this value was read from.",
              type: { kind: "enum" as const, values: [...sourceLabels] },
              required: true,
            },
          ]
        : []),
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
  options: ProvenanceOptions = {},
): { schema: RuntimeSchema; bundle: SchemaBundle } {
  const schemas: Record<string, RuntimeSchema> = { ...(bundle?.schemas ?? {}) };
  const fields: FieldDescriptor[] = [];
  const sourceLabels = options.sourceLabels ?? [];
  const binary = hasBinary(options.sourceKinds);
  const wrapped = provenanceFieldNames(schema, options.fields);

  for (const field of schema.fields) {
    if (!wrapped.has(field.name)) {
      fields.push(field);
      continue;
    }
    const annotation = annotationSchema(schema.id, field, sourceLabels, binary);
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
      const source = record.source;
      provenance[field.name] = {
        confidence: record.confidence,
        ...(typeof evidence === "string" && evidence.length > 0 ? { evidence } : {}),
        ...(typeof source === "string" && source.length > 0 ? { source } : {}),
      };
    }
  }

  return { data, provenance };
}
