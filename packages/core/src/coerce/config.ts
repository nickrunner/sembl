import type { Provider } from "../provider/types.js";
import type { SchemaBundle } from "../schema/types.js";
import type { TraceSink } from "../tracing/types.js";

/**
 * Configuration options shared by global and per-call config.
 */
export interface SemblGlobalConfig {
  /** The LLM provider to use */
  provider?: Provider;
  /** Optional bundle for resolving nested schemas */
  bundle?: SchemaBundle;
  /** Optional trace sinks */
  traceSinks?: TraceSink[];
}

/**
 * Per-call configuration overrides passed to `sembl()`.
 */
export interface SemblCallConfig {
  /** Override the LLM provider for this call */
  provider?: Provider;
  /** Override the bundle for this call */
  bundle?: SchemaBundle;
  /** Override trace sinks for this call */
  traceSinks?: TraceSink[];
}

/**
 * Resolved configuration with a guaranteed provider.
 */
export interface ResolvedConfig {
  provider: Provider;
  bundle?: SchemaBundle;
  traceSinks?: TraceSink[];
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
    traceSinks: callConfig?.traceSinks ?? global.traceSinks,
  };
}
