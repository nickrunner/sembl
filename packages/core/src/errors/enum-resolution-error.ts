import type { EnumSourceFailure } from "../schema/resolve-enum-sources.js";

/**
 * Error thrown when an enum source backing a required field could not be
 * resolved.
 *
 * Falling back to a free-form string here would let the model invent values
 * that pass coercion and fail downstream, so a required field with a dead
 * taxonomy is a hard failure rather than a widening.
 */
export class EnumResolutionError extends Error {
  public readonly failures: EnumSourceFailure[];

  constructor(failures: EnumSourceFailure[]) {
    const summary = failures
      .map((f) => {
        const why =
          f.reason === "empty"
            ? "resolved to no values"
            : `threw: ${f.cause instanceof Error ? f.cause.message : String(f.cause)}`;
        return `  ${f.sourceId} (${f.paths.join(", ")}): ${why}`;
      })
      .join("\n");
    super(`Enum source resolution failed for required fields:\n${summary}`);
    this.name = "EnumResolutionError";
    this.failures = failures;
  }
}
