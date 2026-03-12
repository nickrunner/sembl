/**
 * Describes a single validation issue on a field.
 */
export interface FieldValidationIssue {
  /** Dot-separated path to the field, e.g. "address.city" */
  path: string;
  /** What went wrong */
  message: string;
  /** The value that was received, if any */
  received?: unknown;
}

/**
 * Error thrown when coercion validation fails.
 */
export class CoerceError extends Error {
  public readonly issues: FieldValidationIssue[];

  constructor(issues: FieldValidationIssue[]) {
    const summary = issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
    super(`Coercion validation failed:\n${summary}`);
    this.name = "CoerceError";
    this.issues = issues;
  }
}
