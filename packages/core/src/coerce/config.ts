import type { Provider } from "../provider/types.js";
import type { SchemaBundle } from "../schema/types.js";
import type { EnumResolver } from "../schema/enum-source.js";
import type { TraceSink } from "../tracing/types.js";
import type { InvalidFieldPolicy } from "./resolve-issues.js";
import type { TruncatePolicy } from "./budget.js";
import type { PreprocessSource } from "./coerce.js";

/**
 * Configuration options shared by global and per-call config.
 */
export interface SemblGlobalConfig {
  /** The LLM provider to use */
  provider?: Provider;
  /** Optional bundle for resolving nested schemas */
  bundle?: SchemaBundle;
  /** Optional resolver for @ValuesFrom enum sources */
  enumResolver?: EnumResolver;
  /** Optional trace sinks */
  traceSinks?: TraceSink[];
  /** How many times to send validation failures back for correction. Default 0. */
  maxRepairAttempts?: number;
  /** What to do with a present field that fails validation. Default "throw". */
  onInvalidField?: InvalidFieldPolicy;
  /** Extra guidance rendered into every system prompt. */
  instructions?: string | readonly string[];
  /** Retries when a non-empty input yields no fields. Default 0. */
  retryOnEmpty?: number;
  /** Cap on total source characters sent to the model. Unbounded by default. */
  maxInputChars?: number;
  /** Which part of an over-budget source to cut. Default "tail". */
  truncate?: TruncatePolicy;
  /** Transform each source before budgeting and rendering. */
  preprocess?: PreprocessSource;
  /** Most image sources to send per coercion. Unbounded by default. */
  maxImages?: number;
  /** Most document sources to send per coercion. Unbounded by default. */
  maxDocuments?: number;
}

/**
 * Per-call configuration overrides passed to `sembl()`.
 */
export interface SemblCallConfig {
  /** Override the LLM provider for this call */
  provider?: Provider;
  /** Override the bundle for this call */
  bundle?: SchemaBundle;
  /** Override the enum source resolver for this call */
  enumResolver?: EnumResolver;
  /** Override trace sinks for this call */
  traceSinks?: TraceSink[];
  /** Override the repair attempt budget for this call */
  maxRepairAttempts?: number;
  /** Override the invalid-field policy for this call */
  onInvalidField?: InvalidFieldPolicy;
  /** Guidance for this call. Replaces, rather than extends, the global list. */
  instructions?: string | readonly string[];
  /** Override the empty-result retry budget for this call */
  retryOnEmpty?: number;
  /** Override the input character budget for this call */
  maxInputChars?: number;
  /** Override the truncation policy for this call */
  truncate?: TruncatePolicy;
  /** Override the source preprocessor for this call */
  preprocess?: PreprocessSource;
  /** Override the image cap for this call */
  maxImages?: number;
  /** Override the document cap for this call */
  maxDocuments?: number;
}

/**
 * Resolved configuration with a guaranteed provider.
 */
export interface ResolvedConfig {
  provider: Provider;
  bundle?: SchemaBundle;
  enumResolver?: EnumResolver;
  traceSinks?: TraceSink[];
  maxRepairAttempts?: number;
  onInvalidField?: InvalidFieldPolicy;
  instructions?: string | readonly string[];
  retryOnEmpty?: number;
  maxInputChars?: number;
  truncate?: TruncatePolicy;
  preprocess?: PreprocessSource;
  maxImages?: number;
  maxDocuments?: number;
}

/**
 * Global configuration singleton for SEMBL.
 */
export class SemblConfig {
  private static _config: SemblGlobalConfig = {};

  /** Set global defaults. */
  static configure(config: SemblGlobalConfig): void {
    SemblConfig._config = { ...config };
  }

  /** Reset global config to empty (useful in tests). */
  static reset(): void {
    SemblConfig._config = {};
  }

  /** Read-only access to the current global config. */
  static get current(): Readonly<SemblGlobalConfig> {
    return SemblConfig._config;
  }
}

/**
 * Merge global config with per-call overrides.
 * Throws if no provider is available after merging.
 */
export function resolveConfig(callConfig?: SemblCallConfig): ResolvedConfig {
  const global = SemblConfig.current;
  const provider = callConfig?.provider ?? global.provider;

  if (!provider) {
    throw new Error(
      "No provider configured. Call SemblConfig.configure({ provider }) or pass { provider } to sembl().",
    );
  }

  return {
    provider,
    bundle: callConfig?.bundle ?? global.bundle,
    enumResolver: callConfig?.enumResolver ?? global.enumResolver,
    traceSinks: callConfig?.traceSinks ?? global.traceSinks,
    maxRepairAttempts: callConfig?.maxRepairAttempts ?? global.maxRepairAttempts,
    onInvalidField: callConfig?.onInvalidField ?? global.onInvalidField,
    instructions: callConfig?.instructions ?? global.instructions,
    retryOnEmpty: callConfig?.retryOnEmpty ?? global.retryOnEmpty,
    maxInputChars: callConfig?.maxInputChars ?? global.maxInputChars,
    truncate: callConfig?.truncate ?? global.truncate,
    preprocess: callConfig?.preprocess ?? global.preprocess,
    maxImages: callConfig?.maxImages ?? global.maxImages,
    maxDocuments: callConfig?.maxDocuments ?? global.maxDocuments,
  };
}
