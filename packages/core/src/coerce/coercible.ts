import type { RuntimeSchema } from "../schema/types.js";
import type { SemblCallConfig, ResolvedConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { coerce, partialCoerce } from "./coerce.js";
import { isCoerceInput } from "./sources.js";
import type { CoerceInput } from "./sources.js";

/**
 * Serialize a value to a string for use as LLM input.
 * Strings pass through; objects are JSON-stringified.
 */
function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * A chainable, thenable wrapper around coercion results.
 *
 * Each `.coerceTo()` / `.partialCoerceTo()` call eagerly triggers an LLM call,
 * serializing the previous result as the input string for the next step.
 *
 * Implements `PromiseLike<T>` so it can be `await`ed directly.
 *
 * There is no provenance variant here: an intermediate link's annotations
 * would be serialized into the next call's input and lost, and a terminal one
 * would have to return a different shape than every other link. Use
 * `coerceWithProvenance` / `partialCoerceWithProvenance` directly instead.
 */
export class Coercible<T> implements PromiseLike<T> {
  constructor(
    private readonly _promise: Promise<T>,
    private readonly _config: ResolvedConfig,
    /**
     * Whether the promise holds the caller's original input rather than a
     * coerced result. Only the first link does: it passes labelled sources
     * through untouched, whereas every later link serializes the previous
     * result — a result that merely looks like a source is still a result.
     */
    private readonly _holdsInput = false,
  ) {}

  /** What the next link should send as its input. */
  private _inputFrom(value: T): CoerceInput {
    return this._holdsInput ? (value as unknown as CoerceInput) : serialize(value);
  }

  /** The per-call options every link in the chain shares. */
  private _optionsFor(schema: RuntimeSchema) {
    return {
      provider: this._config.provider,
      schema,
      bundle: this._config.bundle,
      enumResolver: this._config.enumResolver,
      traceSinks: this._config.traceSinks,
      maxRepairAttempts: this._config.maxRepairAttempts,
      onInvalidField: this._config.onInvalidField,
      instructions: this._config.instructions,
      retryOnEmpty: this._config.retryOnEmpty,
      maxInputChars: this._config.maxInputChars,
      truncate: this._config.truncate,
      preprocess: this._config.preprocess,
    };
  }

  /**
   * Chain a full coercion to a new schema.
   * The current value is serialized and used as input for the next LLM call.
   */
  coerceTo<U>(schema: RuntimeSchema): Coercible<U> {
    const next = this._promise.then((value) =>
      coerce<U>(this._inputFrom(value), this._optionsFor(schema)),
    );
    return new Coercible<U>(next, this._config);
  }

  /**
   * Chain a partial coercion to a new schema.
   * The current value is serialized and used as input for the next LLM call.
   */
  partialCoerceTo<U>(schema: RuntimeSchema): Coercible<Partial<U>> {
    const next = this._promise.then((value) =>
      partialCoerce<U>(this._inputFrom(value), this._optionsFor(schema)),
    );
    return new Coercible<Partial<U>>(next, this._config);
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this._promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this._promise.finally(onfinally);
  }
}

/**
 * Entry point for the fluent coercion API.
 *
 * Accepts a string or object as input. Objects are JSON-serialized.
 * Returns a `Coercible<string>` that can be chained with `.coerceTo()` / `.partialCoerceTo()`.
 *
 * @example
 * ```ts
 * SemblConfig.configure({ provider, bundle });
 * const result = await sembl("some user input")
 *   .partialCoerceTo(ProfileSchema)
 *   .coerceTo(IntentSchema);
 * ```
 */
export function sembl(
  input: CoerceInput | Record<string, unknown>,
  config?: SemblCallConfig,
): Coercible<CoerceInput> {
  const resolved = resolveConfig(config);
  const initial: CoerceInput = isCoerceInput(input) ? input : serialize(input);
  return new Coercible<CoerceInput>(Promise.resolve(initial), resolved, true);
}
