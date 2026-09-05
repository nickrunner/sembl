import type {
  RuntimeSchema,
  FieldDescriptor,
  FieldConstraints,
  FieldType,
  SchemaBundle,
} from "../schema/types.js";
import type { ResolvedEnums } from "../schema/enum-source.js";
import type { FieldValidationIssue } from "../errors/coerce-error.js";
import { validateFormat } from "../schema/formats.js";

/**
 * Options shared by both validation modes.
 */
export interface ValidationOptions {
  /** Legal values for dynamic enum sources, from `resolveEnumSources` */
  resolvedEnums?: ResolvedEnums;
}

/** How many allowed values to name before truncating an enum error message. */
const MAX_LISTED_VALUES = 10;

/**
 * Render an allowed-value list for an error message without pasting a
 * several-hundred-entry CMS taxonomy into it.
 */
function summarizeValues(values: readonly string[]): string {
  if (values.length <= MAX_LISTED_VALUES) {
    return values.join(", ");
  }
  const shown = values.slice(0, MAX_LISTED_VALUES).join(", ");
  return `${shown}, … (+${values.length - MAX_LISTED_VALUES} more)`;
}

/** "1 entry" / "3 entries" — limits read as instructions, so they should scan. */
function entries(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

/**
 * Check a single value against the constraints that apply to its runtime type.
 *
 * Array-level bounds are checked against the array; string and number bounds
 * are checked against each element, so a `string[]` field can carry both.
 */
function validateConstraints(
  value: unknown,
  constraints: FieldConstraints,
  path: string,
  issues: FieldValidationIssue[],
): void {
  const { minLength, maxLength, minimum, maximum, minItems, maxItems, pattern, format } =
    constraints;

  if (Array.isArray(value)) {
    if (minItems !== undefined && value.length < minItems) {
      issues.push({
        path,
        message: `Expected at least ${entries(minItems)}, got ${value.length}`,
        received: value,
      });
    }
    if (maxItems !== undefined && value.length > maxItems) {
      issues.push({
        path,
        message: `Expected at most ${entries(maxItems)}, got ${value.length}`,
        received: value,
      });
    }
    // Element bounds only — the array's own bounds were just checked.
    const { minItems: _min, maxItems: _max, ...itemConstraints } = constraints;
    for (let i = 0; i < value.length; i++) {
      validateConstraints(value[i], itemConstraints, `${path}[${i}]`, issues);
    }
    return;
  }

  if (typeof value === "string") {
    if (minLength !== undefined && value.length < minLength) {
      issues.push({
        path,
        message: `Expected at least ${minLength} characters, got ${value.length}`,
        received: value,
      });
    }
    if (maxLength !== undefined && value.length > maxLength) {
      issues.push({
        path,
        message: `Expected at most ${maxLength} characters, got ${value.length}`,
        received: value,
      });
    }
    if (pattern !== undefined && !new RegExp(pattern).test(value)) {
      issues.push({
        path,
        message: `Expected a value matching /${pattern}/, got ${JSON.stringify(value)}`,
        received: value,
      });
    }
    if (format !== undefined) {
      const message = validateFormat(value, format);
      if (message) issues.push({ path, message, received: value });
    }
    return;
  }

  if (typeof value === "number") {
    if (minimum !== undefined && value < minimum) {
      issues.push({
        path,
        message: `Expected a value >= ${minimum}, got ${value}`,
        received: value,
      });
    }
    if (maximum !== undefined && value > maximum) {
      issues.push({
        path,
        message: `Expected a value <= ${maximum}, got ${value}`,
        received: value,
      });
    }
  }
}

/**
 * Validate a value against a FieldType.
 * Returns true if the value matches the expected type.
 */
function validateType(
  value: unknown,
  fieldType: FieldType,
  path: string,
  bundle: SchemaBundle | undefined,
  options: ValidationOptions,
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
    case "dynamicEnum": {
      const values = options.resolvedEnums?.[fieldType.sourceId];
      if (!values || values.length === 0) {
        // Unresolved source: the legal values are unknown, so a string is the
        // strongest claim we can make about the value.
        if (typeof value !== "string") {
          issues.push({
            path,
            message: `Expected string, got ${typeof value}`,
            received: value,
          });
        }
      } else if (typeof value !== "string" || !values.includes(value)) {
        issues.push({
          path,
          message: `Expected one of the ${values.length} allowed "${fieldType.sourceId}" values [${summarizeValues(values)}], got ${JSON.stringify(value)}`,
          received: value,
        });
      }
      break;
    }
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
            options,
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
            options,
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
  options: ValidationOptions,
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

    validateType(value, field.type, path, bundle, options, issues);
    if (field.constraints) {
      validateConstraints(value, field.constraints, path, issues);
    }
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
  options: ValidationOptions = {},
): FieldValidationIssue[] {
  const issues: FieldValidationIssue[] = [];
  validateFields(data, schema, "", bundle, true, options, issues);
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
  options: ValidationOptions = {},
): FieldValidationIssue[] {
  const issues: FieldValidationIssue[] = [];
  validateFields(data, schema, "", bundle, false, options, issues);
  return issues;
}
