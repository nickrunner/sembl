import type { RuntimeSchema } from "../schema/types.js";
import type { SemblCallConfig, ResolvedConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { coerce, partialCoerce } from "./coerce.js";

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
 */
export class Coercible<T> implements PromiseLike<T> {
  constructor(
    private readonly _promise: Promise<T>,
    private readonly _config: ResolvedConfig,
  ) {}

  /**
   * Chain a full coercion to a new schema.
   * The current value is serialized and used as input for the next LLM call.
   */
  coerceTo<U>(schema: RuntimeSchema): Coercible<U> {
    const next = this._promise.then((value) =>
      coerce<U>(serialize(value), {
        provider: this._config.provider,
        schema,
        bundle: this._config.bundle,
        enumResolver: this._config.enumResolver,
        traceSinks: this._config.traceSinks,
      }),
    );
    return new Coercible<U>(next, this._config);
  }

  /**
   * Chain a partial coercion to a new schema.
   * The current value is serialized and used as input for the next LLM call.
   */
  partialCoerceTo<U>(schema: RuntimeSchema): Coercible<Partial<U>> {
    const next = this._promise.then((value) =>
      partialCoerce<U>(serialize(value), {
        provider: this._config.provider,
        schema,
        bundle: this._config.bundle,
        enumResolver: this._config.enumResolver,
        traceSinks: this._config.traceSinks,
      }),
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
  input: string | Record<string, unknown>,
  config?: SemblCallConfig,
): Coercible<string> {
  const resolved = resolveConfig(config);
  const serialized = serialize(input);
  return new Coercible<string>(Promise.resolve(serialized), resolved);
}
