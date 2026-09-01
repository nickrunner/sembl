/**
 * Bounds a field's legal values, beyond its type.
 *
 * Constraints are advisory to the model (they are rendered into the prompt and,
 * where the dialect supports it, into the JSON Schema) and authoritative to the
 * validator, which reports a violation as a `FieldValidationIssue` like any
 * type mismatch.
 */
export interface FieldConstraints {
  /** Maximum string length, inclusive. */
  maxLength?: number;
  /** Minimum string length, inclusive. */
  minLength?: number;
  /** Minimum numeric value, inclusive. */
  min?: number;
  /** Maximum numeric value, inclusive. */
  max?: number;
  /** Minimum array length, inclusive. */
  minItems?: number;
  /** Maximum array length, inclusive. */
  maxItems?: number;
  /** Regular expression source the value must match (no delimiters, no flags). */
  pattern?: string;
}

/**
 * Describes the type of a schema field.
 *
 * `enum` values are fixed when the schema is compiled. `dynamicEnum` defers
 * them to coercion time, naming a source the caller resolves — for value sets
 * that live in a database or CMS rather than in the source tree.
 */
export type FieldType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "array"; items: FieldType }
  | { kind: "object"; nestedSchemaId: string }
  | { kind: "enum"; values: string[] }
  | { kind: "dynamicEnum"; sourceId: string };

/**
 * Describes a single field in a schema.
 */
export interface FieldDescriptor {
  /** Property name as it appears in the class */
  name: string;
  /** Semantic description from @Describe decorator */
  description: string;
  /** The resolved type of this field */
  type: FieldType;
  /** Whether this field is required (definite assignment) */
  required: boolean;
  /** Value bounds from the @Constrain decorator, if any */
  constraints?: FieldConstraints;
}

/**
 * A compiled runtime schema representing a decorated class.
 */
export interface RuntimeSchema {
  /** Unique identifier, typically the class name */
  id: string;
  /** Semantic description from @Schema decorator */
  description: string;
  /** All fields extracted from the class */
  fields: FieldDescriptor[];
}

/**
 * A bundle of all schemas extracted from a set of source files.
 */
export interface SchemaBundle {
  /** Map of schema ID to RuntimeSchema */
  schemas: Record<string, RuntimeSchema>;
}
