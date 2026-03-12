/**
 * Describes the type of a schema field.
 */
export type FieldType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "array"; items: FieldType }
  | { kind: "object"; nestedSchemaId: string }
  | { kind: "enum"; values: string[] };

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
