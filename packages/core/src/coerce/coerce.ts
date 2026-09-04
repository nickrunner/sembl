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
  provenanceInstructions,
  splitProvenance,
  toProvenanceSchema,
} from "./provenance.js";
import { renderSources, toSources } from "./sources.js";
import type { CoerceInput } from "./sources.js";
import type { FieldProvenance, ProvenanceResult } from "./provenance.js";
import { validateStrict, validatePartial } from "./validator.js";
import { resolveIssues } from "./resolve-issues.js";
import type { InvalidFieldPolicy, ResolvedIssue } from "./resolve-issues.js";
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
  /**
   * What to do with a present field that fails validation: `"throw"` (the
   * default), `"drop"` it, or `"clamp"` it to its bounds where that is
   * meaningful and drop it otherwise. Required fields are never dropped.
   *
   * Issues the policy can absorb never trigger a repair round; the provenance
   * variants report them in `issues`, and every run records them in a trace
   * event.
   */
  onInvalidField?: InvalidFieldPolicy;
}

const INVALID_FIELD_POLICIES: readonly InvalidFieldPolicy[] = ["throw", "drop", "clamp"];

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
  issues: ResolvedIssue[];
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
  input: CoerceInput,
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
  const onInvalidField = options.onInvalidField ?? "throw";
  if (!INVALID_FIELD_POLICIES.includes(onInvalidField)) {
    throw new RangeError(
      `onInvalidField must be one of ${INVALID_FIELD_POLICIES.join(", ")}, got ${String(options.onInvalidField)}`,
    );
  }

  // Normalised up front so a bad input fails before any span is opened.
  const sources = toSources(input);
  const sourceLabels = sources.length > 1 ? sources.map((s) => s.label ?? "") : [];

  const tracer = new Tracer(traceSinks);
  const rootSpan = tracer.startSpan(mode, {
    schemaId: schema.id,
    provenance,
    onInvalidField,
    sourceCount: sources.length,
  });

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
      ? `${basePrompt}\n${provenanceInstructions({ sourceLabels })}`
      : basePrompt;
    tracer.addEvent(promptSpan, "promptBuilt", {
      promptLength: systemPrompt.length,
    });
    tracer.endSpan(promptSpan);

    const request = provenance
      ? toProvenanceSchema(schema, bundle, { sourceLabels })
      : { schema, bundle };

    const schemaSpan = tracer.startSpan("buildJsonSchema", {}, rootSpan);
    const jsonSchema = runtimeSchemaToJsonSchema(request.schema, request.bundle, {
      resolvedEnums,
    });
    tracer.endSpan(schemaSpan);

    const validate = mode === "coerce" ? validateStrict : validatePartial;
    const renderedInput = renderSources(sources);
    tracer.addEvent(rootSpan, "inputRendered", {
      sourceCount: sources.length,
      inputLength: renderedInput.length,
    });
    let userInput = renderedInput;
    let issues: FieldValidationIssue[] = [];
    let run: CoercionRun = { data: {}, provenance: {}, issues: [] };

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
        ? { ...splitProvenance(response.data, schema), issues: [] }
        : { data: response.data, provenance: {}, issues: [] };

      const validationSpan = tracer.startSpan("validate", { attempt }, rootSpan);
      issues = validate(run.data, schema, bundle, { resolvedEnums });
      tracer.addEvent(validationSpan, "validated", { issueCount: issues.length });

      if (issues.length === 0) {
        tracer.endSpan(validationSpan);
        return run;
      }

      // A policy that can absorb every issue makes the response acceptable
      // as it stands, so it must not cost a repair round. Anything it cannot
      // absorb — a required field, at any depth — goes back to the model.
      if (onInvalidField !== "throw") {
        const outcome = resolveIssues(run.data, issues, schema, {
          bundle,
          resolvedEnums,
          mode,
          policy: onInvalidField,
        });
        tracer.addEvent(validationSpan, "issuesResolved", {
          policy: onInvalidField,
          dropped: outcome.resolved
            .filter((r) => r.resolution === "dropped")
            .map((r) => r.resolvedPath),
          clamped: outcome.resolved
            .filter((r) => r.resolution === "clamped")
            .map((r) => r.resolvedPath),
          unresolved: outcome.unresolved.map((issue) => issue.path),
        });
        if (outcome.unresolved.length === 0) {
          tracer.endSpan(validationSpan);
          return {
            data: outcome.data,
            provenance: pruneProvenance(run.provenance, outcome.resolved),
            issues: outcome.resolved,
          };
        }
      }

      tracer.endSpan(validationSpan);

      if (attempt < maxRepairAttempts) {
        tracer.addEvent(rootSpan, "repairAttempt", {
          attempt: attempt + 1,
          issueCount: issues.length,
          paths: issues.map((issue) => issue.path),
        });
        // Feed back the unwrapped data: it is what the issues refer to, and
        // the schema still forces the wrapper shape on the way back.
        userInput = buildRepairInput(renderedInput, run.data, issues);
      }
    }

    throw new CoerceError(issues);
  } finally {
    tracer.endSpan(rootSpan);
  }
}

/**
 * Forget the provenance of a top-level field that was dropped: an annotation
 * for a value the caller never sees would only mislead a review UI.
 */
function pruneProvenance(
  provenance: Record<string, FieldProvenance>,
  resolved: readonly ResolvedIssue[],
): Record<string, FieldProvenance> {
  const pruned = { ...provenance };
  for (const issue of resolved) {
    if (issue.resolution === "dropped" && /^[^.[]+$/.test(issue.resolvedPath)) {
      delete pruned[issue.resolvedPath];
    }
  }
  return pruned;
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
  input: CoerceInput,
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
  input: CoerceInput,
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
  input: CoerceInput,
  options: CoerceOptions,
): Promise<ProvenanceResult<T>> {
  const { data, provenance, issues } = await runCoercion(input, options, {
    mode: "coerce",
    provenance: true,
  });
  return { data: data as T, provenance, issues };
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
  input: CoerceInput,
  options: CoerceOptions,
): Promise<ProvenanceResult<Partial<T>>> {
  const { data, provenance, issues } = await runCoercion(input, options, {
    mode: "partialCoerce",
    provenance: true,
  });
  return { data: stripNulls(data) as Partial<T>, provenance, issues };
}
