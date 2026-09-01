import type { SchemaBundle } from "@sembl/core";

/**
 * Annotation extracted from a @Schema decorator.
 */
export interface SchemaAnnotation {
  /** Class name */
  className: string;
  /** Description string from @Schema(description) */
  description: string;
}

/**
 * Annotation extracted from a @Describe decorator on a property.
 */
export interface FieldAnnotation {
  /** Property name */
  name: string;
  /** Description string from @Describe(description) */
  description: string;
  /** Raw TypeScript type text */
  rawType: string;
  /** Whether the property is optional (?:) */
  optional: boolean;
}

/**
 * Configuration for the compiler.
 */
export interface CompilerConfig {
  /** Glob patterns for input source files */
  inputPatterns: string[];
  /** Output directory for generated schema files */
  outputDir: string;
  /** Optional tsconfig path */
  tsconfigPath?: string;
}

/**
 * Result of extracting schemas from source files.
 *
 * Extends `SchemaBundle` so it can be handed straight to the emitter, and adds
 * the diagnostics raised on the way — a field whose type the schema contract
 * cannot express still emits, so the warnings are what tell the caller the
 * output does not match the source.
 */
export interface ExtractionResult extends SchemaBundle {
  /** Any warnings generated during extraction, in discovery order */
  warnings: string[];
}
