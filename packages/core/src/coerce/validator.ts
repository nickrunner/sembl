import type { RuntimeSchema, FieldDescriptor, FieldType, SchemaBundle } from "../schema/types.js";
import type { FieldValidationIssue } from "../errors/coerce-error.js";

/**
 * Validate a value against a FieldType.
 * Returns true if the value matches the expected type.
 */
function validateType(
  value: unknown,
  fieldType: FieldType,
  path: string,
  bundle: SchemaBundle | undefined,
  issues: FieldValidationIssue[],
): void {
  if (value === null || value === undefined) {
    return; // Null/undefined handled at field level
  }

  switch (fieldType.kind) {
    case "string":
      if (typeof value !== "string") {
        issues.push({
          path,
          message: `Expected string, got ${typeof value}`,
          received: value,
        });
      }
      break;
    case "number":
      if (typeof value !== "number") {
        issues.push({
          path,
          message: `Expected number, got ${typeof value}`,
          received: value,
        });
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        issues.push({
          path,
          message: `Expected boolean, got ${typeof value}`,
          received: value,
        });
      }
      break;
    case "enum":
      if (typeof value !== "string" || !fieldType.values.includes(value)) {
        issues.push({
          path,
          message: `Expected one of [${fieldType.values.join(", ")}], got ${JSON.stringify(value)}`,
          received: value,
        });
      }
      break;
    case "dynamicEnum":
      // Legal values are supplied at coercion time; without them only the
      // underlying string type can be checked here.
      if (typeof value !== "string") {
        issues.push({
          path,
          message: `Expected string, got ${typeof value}`,
          received: value,
        });
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        issues.push({
          path,
          message: `Expected array, got ${typeof value}`,
          received: value,
        });
      } else {
        for (let i = 0; i < value.length; i++) {
          validateType(
            value[i],
            fieldType.items,
            `${path}[${i}]`,
            bundle,
            issues,
          );
        }
      }
      break;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        issues.push({
          path,
          message: `Expected object, got ${Array.isArray(value) ? "array" : typeof value}`,
          received: value,
        });
      } else if (bundle) {
        const nested = bundle.schemas[fieldType.nestedSchemaId];
        if (nested) {
          validateFields(
            value as Record<string, unknown>,
            nested,
            path,
            bundle,
            true, // strict for nested objects in strict mode
            issues,
          );
        }
      }
      break;
    }
  }
}

/**
 * Validate fields of a data object against a RuntimeSchema.
 */
function validateFields(
  data: Record<string, unknown>,
  schema: RuntimeSchema,
  parentPath: string,
  bundle: SchemaBundle | undefined,
  strict: boolean,
  issues: FieldValidationIssue[],
): void {
  for (const field of schema.fields) {
    const path = parentPath ? `${parentPath}.${field.name}` : field.name;
    const value = data[field.name];

    if (value === null || value === undefined) {
      if (strict && field.required) {
        issues.push({
          path,
          message: "Required field is missing",
          received: value,
        });
      }
      continue;
    }

    validateType(value, field.type, path, bundle, issues);
  }
}

/**
 * Validate data against a RuntimeSchema in strict mode.
 * All required fields must be present and correctly typed.
 * Returns validation issues (empty array means valid).
 */
export function validateStrict(
  data: Record<string, unknown>,
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): FieldValidationIssue[] {
  const issues: FieldValidationIssue[] = [];
  validateFields(data, schema, "", bundle, true, issues);
  return issues;
}

/**
 * Validate data against a RuntimeSchema in partial mode.
 * Only validates types of fields that ARE present; never fails for missing fields.
 * Returns validation issues (empty array means valid).
 */
export function validatePartial(
  data: Record<string, unknown>,
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): FieldValidationIssue[] {
  const issues: FieldValidationIssue[] = [];
  validateFields(data, schema, "", bundle, false, issues);
  return issues;
}
