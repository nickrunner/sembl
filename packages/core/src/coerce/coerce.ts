import type { RuntimeSchema, SchemaBundle } from "../schema/types.js";
import type { Provider } from "../provider/types.js";
import type { TraceSink } from "../tracing/types.js";
import { CoerceError } from "../errors/coerce-error.js";
import { runtimeSchemaToJsonSchema } from "../schema/json-schema.js";
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
  /** Optional trace sinks */
  traceSinks?: TraceSink[];
}

/**
 * Coerce user input into a fully validated instance of the target schema.
 * Throws CoerceError if validation fails (required fields missing, type mismatches).
 */
export async function coerce<T>(
  input: string,
  options: CoerceOptions,
): Promise<T> {
  const { provider, schema, bundle, traceSinks } = options;
  const tracer = new Tracer(traceSinks);
  const rootSpan = tracer.startSpan("coerce", { schemaId: schema.id });

  try {
    const promptSpan = tracer.startSpan("buildPrompt", {}, rootSpan);
    const systemPrompt = buildPrompt(schema, bundle);
    tracer.addEvent(promptSpan, "promptBuilt", {
      promptLength: systemPrompt.length,
    });
    tracer.endSpan(promptSpan);

    const schemaSpan = tracer.startSpan("buildJsonSchema", {}, rootSpan);
    const jsonSchema = runtimeSchemaToJsonSchema(schema, bundle);
    tracer.endSpan(schemaSpan);

    const llmSpan = tracer.startSpan("llmCall", {}, rootSpan);
    const response = await provider.complete({
      systemPrompt,
      userInput: input,
      jsonSchema,
      schema,
    });
    tracer.addEvent(llmSpan, "responseReceived", { usage: response.usage });
    tracer.endSpan(llmSpan);

    const validationSpan = tracer.startSpan("validate", {}, rootSpan);
    const issues = validateStrict(response.data, schema, bundle);
    tracer.endSpan(validationSpan);

    if (issues.length > 0) {
      throw new CoerceError(issues);
    }

    return response.data as T;
  } finally {
    tracer.endSpan(rootSpan);
  }
}

/**
 * Coerce user input into a partial instance of the target schema.
 * Only validates types of fields that are present; never throws for missing fields.
 * Throws CoerceError only if present fields have type mismatches.
 */
export async function partialCoerce<T>(
  input: string,
  options: CoerceOptions,
): Promise<Partial<T>> {
  const { provider, schema, bundle, traceSinks } = options;
  const tracer = new Tracer(traceSinks);
  const rootSpan = tracer.startSpan("partialCoerce", { schemaId: schema.id });

  try {
    const systemPrompt = buildPrompt(schema, bundle);
    const jsonSchema = runtimeSchemaToJsonSchema(schema, bundle);

    const response = await provider.complete({
      systemPrompt,
      userInput: input,
      jsonSchema,
      schema,
    });

    const issues = validatePartial(response.data, schema, bundle);

    if (issues.length > 0) {
      throw new CoerceError(issues);
    }

    // Strip null values for partial results
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(response.data)) {
      if (value !== null) {
        result[key] = value;
      }
    }

    return result as Partial<T>;
  } finally {
    tracer.endSpan(rootSpan);
  }
}
