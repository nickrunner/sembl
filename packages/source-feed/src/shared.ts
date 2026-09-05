/**
 * What every renderer in this package shares: the error it throws, the size
 * guard it applies before parsing, and the outline format JSON and XML are
 * both rendered into.
 */

/** Which parser an error came from. */
export type FeedFormat = "json" | "xml" | "feed" | "ics";

/**
 * Thrown for input this package cannot make sense of — an unclosed XML tag,
 * an iCalendar file with no VCALENDAR, a path that names nothing — and for
 * input over the size guard. Always says which format and, where the parser
 * knows it, which line.
 */
export class FeedError extends Error {
  constructor(
    public readonly format: FeedFormat,
    message: string,
    public readonly line?: number,
  ) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = "FeedError";
  }
}

/** Options every parser in this package accepts. */
export interface SizeGuardOptions {
  /**
   * Refuse input longer than this many characters rather than spend the
   * time parsing it. Default 8,000,000. The parsers are linear in the input,
   * so this is a bound on work, not a workaround for one.
   */
  maxInputChars?: number;
}

export const DEFAULT_MAX_INPUT_CHARS = 8_000_000;

/** Throw a {@link FeedError} for input that is not a string or is too long. */
export function guardInput(input: unknown, format: FeedFormat, options: SizeGuardOptions = {}): string {
  if (typeof input !== "string") {
    throw new FeedError(format, `Expected a string of ${format.toUpperCase()}, got ${describeType(input)}`);
  }
  const max = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  if (input.length > max) {
    throw new FeedError(
      format,
      `Input is ${input.length.toLocaleString("en-US")} characters, over the ${max.toLocaleString("en-US")}-character limit (raise maxInputChars to allow it)`,
    );
  }
  return input;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : typeof value;
}

/**
 * One line of an outline. `depth` is the indent level; `text` is the line
 * itself, already in its `key: value` or `1. value` form.
 */
export interface OutlineLine {
  depth: number;
  text: string;
}

/** Two spaces per level: enough to read, cheap in tokens. */
const INDENT = "  ";

/** Join outline lines into the text a model reads. */
export function renderOutline(lines: readonly OutlineLine[]): string {
  return lines.map((line) => INDENT.repeat(line.depth) + line.text).join("\n");
}

/**
 * Push a `key: value` line, or — for a value that spans lines — a `key:`
 * line followed by the value's lines indented one level, so a paragraph of
 * description stays whole and still reads as belonging to its key.
 */
export function pushScalar(lines: OutlineLine[], depth: number, key: string, value: string, sep = ":"): void {
  if (!value.includes("\n")) {
    lines.push({ depth, text: `${key}${sep} ${value}` });
    return;
  }
  lines.push({ depth, text: `${key}${sep}` });
  for (const part of value.split("\n")) lines.push({ depth: depth + 1, text: part });
}

/** Collapse runs of blank lines and trailing whitespace in a text value. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Bring a label and a 1-based index together the way every `*Items` helper does. */
export function itemLabel(label: string, index: number): string {
  return `${label} ${index}`;
}
