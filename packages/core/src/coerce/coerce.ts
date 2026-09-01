import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";
import type { EnumResolver, ResolvedEnums } from "../schema/enum-source.js";
import type { Provider } from "../provider/types.js";
import type { TraceSink, TraceSpan } from "../tracing/types.js";
import { CoerceError } from "../errors/coerce-error.js";
import { EnumResolutionError } from "../errors/enum-resolution-error.js";
import { runtimeSchemaToJsonSchema } from "../schema/json-schema.js";
import { resolveEnumSources } from "../schema/resolve-enum-sources.js";
import type { FieldValidationIssue } from "../errors/coerce-error.js";
import { buildPrompt } from "./prompt-builder.js";
import { buildRepairInput } from "./repair.js";
import {
  PROVENANCE_INSTRUCTIONS,
  splitProvenance,
  toProvenanceSchema,
} from "./provenance.js";
import type { FieldProvenance, ProvenanceResult } from "./provenance.js";
import { validateStrict, validatePartial } from "./validator.js";
import { Tracer } from "../tracing/tracer.js";

/**
 * Options for coerce and partialCoerce.
 */
export interface CoerceOptions {
  /** The LLM provider to use */
  provider: Provider;
  /** The target schema */
  schema: RuntimeSchema;
  /** Optional bundle for resolving nested schemas */
  bundle?: SchemaBundle;
  /** Optional resolver for @ValuesFrom enum sources */
  enumResolver?: EnumResolver;
  /** Optional trace sinks */
  traceSinks?: TraceSink[];
  /**
   * How many times to send validation failures back to the model for
   * correction before giving up. Defaults to 0 — no repair.
   *
   * A repair costs an extra call only when validation actually failed, so the
   * happy path is unaffected. It is off by default because it also multiplies
   * worst-case latency, which a caller should opt into knowingly. For
   * extraction from messy input — scraped HTML, third-party payloads — 1 is
   * usually the right setting.
   */
  maxRepairAttempts?: number;
}

/**
 * Resolve every dynamic enum source the schema reaches, under its own span.
 *
 * Throws EnumResolutionError when a source backing a required field could not
 * be resolved: widening a required field to a free-form string lets the model
 * emit values that pass coercion and fail downstream. Failures that only touch
 * optional fields are recorded as trace events and the field widens, so a
 * flaky taxonomy cannot take down an import for a field nobody required.
 */
async function resolveEnums(
  schema: RuntimeSchema,
  bundle: SchemaBundle | undefined,
  enumResolver: EnumResolver | undefined,
  tracer: Tracer,
  parent: TraceSpan,
): Promise<ResolvedEnums | undefined> {
  if (!enumResolver) {
    return undefined;
  }

  const span = tracer.startSpan("resolveEnums", {}, parent);
  try {
    const { enums, failures } = await resolveEnumSources(
      schema,
      enumResolver,
      bundle,
    );

    tracer.addEvent(span, "enumsResolved", {
      sourceIds: Object.keys(enums),
      valueCounts: Object.fromEntries(
        Object.entries(enums).map(([id, values]) => [id, values.length]),
      ),
    });

    for (const failure of failures) {
      tracer.addEvent(span, "enumSourceFailed", {
        sourceId: failure.sourceId,
        reason: failure.reason,
        required: failure.required,
        paths: failure.paths,
      });
    }

    const fatal = failures.filter((f) => f.required);
    if (fatal.length > 0) {
      throw new EnumResolutionError(fatal);
    }

    return enums;
  } finally {
    tracer.endSpan(span);
  }
}

/** What a pipeline run produced, before mode-specific post-processing. */
interface CoercionRun {
  data: Record<string, unknown>;
  provenance: Record<string, FieldProvenance>;
}

interface RunOptions {
  mode: "coerce" | "partialCoerce";
  /** Ask the model to annotate each field with where the value came from. */
  provenance: boolean;
}

/**
 * Run the shared coercion pipeline: resolve enum sources, build the prompt and
 * JSON Schema from them, call the provider, validate, and — when asked — send
 * validation failures back for correction.
 *
 * All four modes trace the same spans; they differ in the root span name, in
 * which validator decides whether the response is acceptable, and in whether
 * the request is wrapped for provenance.
 */
async function runCoercion(
  input: string,
  options: CoerceOptions,
  { mode, provenance }: RunOptions,
): Promise<CoercionRun> {
  const { provider, schema, bundle, enumResolver, traceSinks } = options;
  const maxRepairAttempts = options.maxRepairAttempts ?? 0;
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0) {
    throw new RangeError(
      `maxRepairAttempts must be a non-negative integer, got ${String(options.maxRepairAttempts)}`,
    );
  }

  const tracer = new Tracer(traceSinks);
  const rootSpan = tracer.startSpan(mode, { schemaId: schema.id, provenance });

  try {
    // Sources are resolved against the target schema even in a provenance run:
    // wrapping does not change which sources are reachable, and the wrapper's
    // extra nesting would only make the walk more expensive.
    const resolvedEnums = await resolveEnums(
      schema,
      bundle,
      enumResolver,
      tracer,
      rootSpan,
    );

    // The prompt describes the target schema either way — its field semantics
    // are what the model needs. The wrapper shape is carried by the JSON
    // Schema, and how to judge confidence by the extra instructions.
    const promptSpan = tracer.startSpan("buildPrompt", {}, rootSpan);
    const basePrompt = buildPrompt(schema, bundle, { resolvedEnums });
    const systemPrompt = provenance
      ? `${basePrompt}\n${PROVENANCE_INSTRUCTIONS}`
      : basePrompt;
    tracer.addEvent(promptSpan, "promptBuilt", {
      promptLength: systemPrompt.length,
    });
    tracer.endSpan(promptSpan);

    const request = provenance
      ? toProvenanceSchema(schema, bundle)
      : { schema, bundle };

    const schemaSpan = tracer.startSpan("buildJsonSchema", {}, rootSpan);
    const jsonSchema = runtimeSchemaToJsonSchema(request.schema, request.bundle, {
      resolvedEnums,
    });
    tracer.endSpan(schemaSpan);

    const validate = mode === "coerce" ? validateStrict : validatePartial;
    let userInput = input;
    let issues: FieldValidationIssue[] = [];
    let run: CoercionRun = { data: {}, provenance: {} };

    for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
      const llmSpan = tracer.startSpan("llmCall", { attempt }, rootSpan);
      const response = await provider.complete({
        systemPrompt,
        userInput,
        jsonSchema,
        schema: request.schema,
        bundle: request.bundle,
        resolvedEnums,
      });
      tracer.addEvent(llmSpan, "responseReceived", { usage: response.usage });
      tracer.endSpan(llmSpan);

      run = provenance
        ? splitProvenance(response.data, schema)
        : { data: response.data, provenance: {} };

      const validationSpan = tracer.startSpan("validate", { attempt }, rootSpan);
      issues = validate(run.data, schema, bundle, { resolvedEnums });
      tracer.addEvent(validationSpan, "validated", { issueCount: issues.length });
      tracer.endSpan(validationSpan);

      if (issues.length === 0) {
        return run;
      }

      if (attempt < maxRepairAttempts) {
        tracer.addEvent(rootSpan, "repairAttempt", {
          attempt: attempt + 1,
          issueCount: issues.length,
          paths: issues.map((issue) => issue.path),
        });
        // Feed back the unwrapped data: it is what the issues refer to, and
        // the schema still forces the wrapper shape on the way back.
        userInput = buildRepairInput(input, run.data, issues);
      }
    }

    throw new CoerceError(issues);
  } finally {
    tracer.endSpan(rootSpan);
  }
}

/** Drop nulls, which a partial result reports as absence. */
function stripNulls(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Coerce user input into a fully validated instance of the target schema.
 * Throws CoerceError if validation fails (required fields missing, type
 * mismatches, constraint violations, values outside a resolved taxonomy).
 * Throws EnumResolutionError if a required field's enum source cannot be resolved.
 */
export async function coerce<T>(
  input: string,
  options: CoerceOptions,
): Promise<T> {
  const { data } = await runCoercion(input, options, {
    mode: "coerce",
    provenance: false,
  });
  return data as T;
}

/**
 * Coerce user input into a partial instance of the target schema.
 * Only validates types of fields that are present; never throws for missing fields.
 * Throws CoerceError only if present fields have type mismatches or violate
 * their constraints, and EnumResolutionError if a required field's enum source
 * cannot be resolved.
 */
export async function partialCoerce<T>(
  input: string,
  options: CoerceOptions,
): Promise<Partial<T>> {
  const { data } = await runCoercion(input, options, {
    mode: "partialCoerce",
    provenance: false,
  });
  return stripNulls(data) as Partial<T>;
}

/**
 * Like {@link coerce}, but each field also comes back with how well the input
 * supported it and the text it was read from.
 *
 * Costs a larger schema and a longer response, so reach for it where a human
 * reviews the result — a pre-filled form that should flag its guesses — rather
 * than on a hot path.
 */
export async function coerceWithProvenance<T>(
  input: string,
  options: CoerceOptions,
): Promise<ProvenanceResult<T>> {
  const { data, provenance } = await runCoercion(input, options, {
    mode: "coerce",
    provenance: true,
  });
  return { data: data as T, provenance };
}

/**
 * Like {@link partialCoerce}, but each field also comes back with how well the
 * input supported it and the text it was read from.
 *
 * This is the one a form pre-fill usually wants: fields the input never
 * mentioned are simply absent, and the ones that are present say how much to
 * trust them.
 */
export async function partialCoerceWithProvenance<T>(
  input: string,
  options: CoerceOptions,
): Promise<ProvenanceResult<Partial<T>>> {
  const { data, provenance } = await runCoercion(input, options, {
    mode: "partialCoerce",
    provenance: true,
  });
  return { data: stripNulls(data) as Partial<T>, provenance };
}
