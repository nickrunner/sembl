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
 */
export interface ExtractionResult {
  /** Schema annotations with their field annotations */
  schemas: Array<{
    schema: SchemaAnnotation;
    fields: FieldAnnotation[];
  }>;
  /** Any warnings generated during extraction */
  warnings: string[];
}
