import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";
import type { EnumResolver, ResolvedEnums } from "../schema/enum-source.js";
import type { Provider } from "../provider/types.js";
import type { TraceSink, TraceSpan } from "../tracing/types.js";
import { CoerceError } from "../errors/coerce-error.js";
import { EnumResolutionError } from "../errors/enum-resolution-error.js";
import { runtimeSchemaToJsonSchema } from "../schema/json-schema.js";
import { resolveEnumSources } from "../schema/resolve-enum-sources.js";
import { buildPrompt } from "./prompt-builder.js";
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

/**
 * Run the shared coercion pipeline: resolve enum sources, build the prompt and
 * JSON Schema from them, call the provider, and validate the result.
 *
 * Both modes trace the same spans; they differ only in the root span name and
 * in which validator decides whether the response is acceptable.
 */
async function runCoercion(
  input: string,
  options: CoerceOptions,
  mode: "coerce" | "partialCoerce",
): Promise<Record<string, unknown>> {
  const { provider, schema, bundle, enumResolver, traceSinks } = options;
  const tracer = new Tracer(traceSinks);
  const rootSpan = tracer.startSpan(mode, { schemaId: schema.id });

  try {
    const resolvedEnums = await resolveEnums(
      schema,
      bundle,
      enumResolver,
      tracer,
      rootSpan,
    );

    const promptSpan = tracer.startSpan("buildPrompt", {}, rootSpan);
    const systemPrompt = buildPrompt(schema, bundle, { resolvedEnums });
    tracer.addEvent(promptSpan, "promptBuilt", {
      promptLength: systemPrompt.length,
    });
    tracer.endSpan(promptSpan);

    const schemaSpan = tracer.startSpan("buildJsonSchema", {}, rootSpan);
    const jsonSchema = runtimeSchemaToJsonSchema(schema, bundle, {
      resolvedEnums,
    });
    tracer.endSpan(schemaSpan);

    const llmSpan = tracer.startSpan("llmCall", {}, rootSpan);
    const response = await provider.complete({
      systemPrompt,
      userInput: input,
      jsonSchema,
      schema,
      resolvedEnums,
    });
    tracer.addEvent(llmSpan, "responseReceived", { usage: response.usage });
    tracer.endSpan(llmSpan);

    const validationSpan = tracer.startSpan("validate", {}, rootSpan);
    const validate = mode === "coerce" ? validateStrict : validatePartial;
    const issues = validate(response.data, schema, bundle, { resolvedEnums });
    tracer.addEvent(validationSpan, "validated", { issueCount: issues.length });
    tracer.endSpan(validationSpan);

    if (issues.length > 0) {
      throw new CoerceError(issues);
    }

    return response.data;
  } finally {
    tracer.endSpan(rootSpan);
  }
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
  const data = await runCoercion(input, options, "coerce");
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
  const data = await runCoercion(input, options, "partialCoerce");

  // Strip null values for partial results
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null) {
      result[key] = value;
    }
  }

  return result as Partial<T>;
}
