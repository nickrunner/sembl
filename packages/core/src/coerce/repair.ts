import type { FieldValidationIssue } from "../errors/coerce-error.js";

/** Longest rendering of a rejected value before it is elided. */
const MAX_RECEIVED_LENGTH = 200;

function renderReceived(received: unknown): string {
  if (received === undefined) {
    return "(missing)";
  }
  const text = JSON.stringify(received) ?? String(received);
  return text.length > MAX_RECEIVED_LENGTH
    ? `${text.slice(0, MAX_RECEIVED_LENGTH)}… (truncated)`
    : text;
}

/**
 * Build the input for a repair attempt: the original input (already rendered
 * as delimited source blocks), the output that was rejected, and what was
 * wrong with it. The correction sits outside the source blocks, where the
 * system prompt says instructions live.
 *
 * The `Provider` interface is single-turn, so the correction has to travel as
 * user text rather than as a real assistant turn. In practice that reads to
 * the model the same way, and it keeps repair working on every provider
 * without widening the provider contract. Exported so a caller who wants
 * different wording can build their own and call the provider directly.
 */
export function buildRepairInput(
  originalInput: string,
  rejected: Record<string, unknown>,
  issues: FieldValidationIssue[],
): string {
  const lines = [
    originalInput,
    "",
    "---",
    "",
    "A previous attempt at this extraction produced:",
    "",
    JSON.stringify(rejected, null, 2),
    "",
    "It was rejected because:",
    "",
  ];

  for (const issue of issues) {
    lines.push(`- ${issue.path}: ${issue.message} (received: ${renderReceived(issue.received)})`);
  }

  lines.push(
    "",
    "Return a corrected object addressing every point above. Keep the values " +
      "that were already right — only the listed fields are wrong. If the " +
      "input genuinely does not support a value, leave the field out rather " +
      "than inventing one.",
  );

  return lines.join("\n");
}
