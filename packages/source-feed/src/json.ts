import type { Source } from "@sembl/core";
import { FeedError, itemLabel, pushScalar, renderOutline, tidyText } from "./shared.js";
import type { OutlineLine } from "./shared.js";

/** Options for {@link jsonToText}, {@link jsonSource} and {@link jsonItems}. */
export interface JsonSourceOptions {
  /**
   * How many levels of nesting to expand below the top level: `0` renders
   * every nested container as one line of compact JSON on its key's line,
   * `1` expands the top-level containers but not the ones inside them, and
   * so on. The facts survive either way; only the layout goes. Default 12.
   */
  maxDepth?: number;
  /**
   * Most elements to render per array; a line saying how many were left
   * out follows. Default 200.
   */
  maxArrayItems?: number;
  /**
   * Keys to drop wherever they occur — tracking ids, hashes, internal
   * timestamps, whatever the model should not be reading.
   */
  omitKeys?: readonly string[];
  /**
   * Called for every property and element before it is rendered, with its
   * path (`guests[0].email`) and value. Return a replacement value, or
   * `undefined` to drop it. Runs after `omitKeys`.
   */
  redact?: (path: string, value: unknown) => unknown;
}

interface Resolved {
  maxDepth: number;
  maxArrayItems: number;
  omit: Set<string>;
  redact?: (path: string, value: unknown) => unknown;
}

function resolve(options: JsonSourceOptions): Resolved {
  return {
    maxDepth: Math.max(0, options.maxDepth ?? 12),
    maxArrayItems: Math.max(0, options.maxArrayItems ?? 200),
    omit: new Set(options.omitKeys ?? []),
    redact: options.redact,
  };
}

/** Whether a key can be written in dot notation. */
const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

function childPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  if (PLAIN_KEY.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}

function scalarText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return tidyText(value) || '""';
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "invalid date" : value.toISOString();
  if (typeof value === "undefined") return "undefined";
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Safe compact JSON for a subtree past `maxDepth`; cycles become a marker. */
function compact(value: unknown, seen: Set<object>): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "(circular)";
      }
      if (typeof v === "bigint") return String(v);
      return v;
    }) ?? "undefined";
  } catch {
    return "(unserialisable)";
  }
}

/**
 * Append the outline of `value` under `key` at `depth`. `seen` holds the
 * containers on the current path so a cycle renders as `(circular)` rather
 * than running forever.
 */
function pushValue(
  lines: OutlineLine[],
  depth: number,
  key: string,
  path: string,
  value: unknown,
  opts: Resolved,
  seen: Set<object>,
  sep = ":",
): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push({ depth, text: `${key}${sep} (empty list)` });
      return;
    }
    if (seen.has(value)) {
      lines.push({ depth, text: `${key}${sep} (circular)` });
      return;
    }
    if (depth + 1 > opts.maxDepth) {
      lines.push({ depth, text: `${key}${sep} ${compact(value, seen)}` });
      return;
    }
    lines.push({ depth, text: `${key}${sep}` });
    seen.add(value);
    const shown = Math.min(value.length, opts.maxArrayItems);
    for (let i = 0; i < shown; i++) {
      const itemPath = childPath(path, i);
      let item = value[i];
      if (opts.redact) {
        item = opts.redact(itemPath, item);
        if (item === undefined) {
          lines.push({ depth: depth + 1, text: `${i + 1}. (redacted)` });
          continue;
        }
      }
      if (Array.isArray(item) || isPlainObject(item)) {
        pushValue(lines, depth + 1, String(i + 1), itemPath, item, opts, seen, ".");
      } else {
        pushScalar(lines, depth + 1, String(i + 1), scalarText(item), ".");
      }
    }
    if (shown < value.length) {
      lines.push({ depth: depth + 1, text: `… ${value.length - shown} more item${value.length - shown === 1 ? "" : "s"} not shown` });
    }
    seen.delete(value);
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([k]) => !opts.omit.has(k));
    if (entries.length === 0) {
      lines.push({ depth, text: `${key}${sep} (empty object)` });
      return;
    }
    if (seen.has(value)) {
      lines.push({ depth, text: `${key}${sep} (circular)` });
      return;
    }
    if (depth + 1 > opts.maxDepth) {
      lines.push({ depth, text: `${key}${sep} ${compact(value, seen)}` });
      return;
    }
    lines.push({ depth, text: `${key}${sep}` });
    seen.add(value);
    pushEntries(lines, depth + 1, path, entries, opts, seen);
    seen.delete(value);
    return;
  }

  pushScalar(lines, depth, key, scalarText(value), sep);
}

function pushEntries(
  lines: OutlineLine[],
  depth: number,
  path: string,
  entries: [string, unknown][],
  opts: Resolved,
  seen: Set<object>,
): void {
  for (const [k, raw] of entries) {
    const entryPath = childPath(path, k);
    let v = raw;
    if (opts.redact) {
      v = opts.redact(entryPath, v);
      if (v === undefined) continue;
    }
    pushValue(lines, depth, k, entryPath, v, opts, seen);
  }
}

/**
 * Render a JSON value as an indented `key: value` outline: arrays as
 * numbered items, nulls written out, empty containers noted, long strings
 * kept whole. The output carries no braces, quotes or commas, which is what
 * makes it cheaper and clearer for a model than the JSON itself.
 */
export function jsonToText(value: unknown, options: JsonSourceOptions = {}): string {
  const opts = resolve(options);
  const lines: OutlineLine[] = [];
  const seen = new Set<object>();
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty list)";
    // The list is the top level: number its items from depth 0, no header.
    pushValue(lines, -1, "", "", value, opts, seen);
    lines.shift();
  } else if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([k]) => !opts.omit.has(k));
    if (entries.length === 0) return "(empty object)";
    seen.add(value);
    pushEntries(lines, 0, "", entries, opts, seen);
  } else {
    return scalarText(value);
  }
  return renderOutline(lines);
}

/**
 * A JSON payload as a labelled SEMBL source, rendered with
 * {@link jsonToText}. Pass what an API returned, not the raw body: the
 * value is walked, not parsed.
 */
export function jsonSource(value: unknown, label?: string, options?: JsonSourceOptions): Source {
  const text = jsonToText(value, options);
  return label ? { label, text } : { text };
}

/** Split `a.b[0].c` or `a[0]["b c"]` into its steps. */
function parsePath(path: string): (string | number)[] {
  const steps: (string | number)[] = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  const trimmed = path.trim();
  while ((match = pattern.exec(trimmed)) !== null) {
    const between = trimmed.slice(consumed, match.index);
    if (between !== "" && between !== ".") {
      throw new FeedError("json", `Cannot read path "${path}": unexpected "${between}"`);
    }
    if (match[1] !== undefined) steps.push(match[1]);
    else if (match[2] !== undefined) steps.push(Number(match[2]));
    else steps.push((match[3] ?? match[4] ?? "").replace(/\\(.)/g, "$1"));
    consumed = match.index + match[0].length;
  }
  if (consumed !== trimmed.length) {
    throw new FeedError("json", `Cannot read path "${path}": unexpected "${trimmed.slice(consumed)}"`);
  }
  return steps;
}

/**
 * The value at a dot/bracket path — `data.listings`, `results[0].items`,
 * `["odd key"].list` — or `undefined` when any step is missing. The empty
 * path is the value itself.
 */
export function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const step of parsePath(path)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/**
 * One source per element of the array at `path`, for `coerceMany`. Labels
 * are numbered from 1 — "Listing 1", "Listing 2" — so provenance and
 * progress output can name each item. Throws when the path is missing or
 * does not hold an array.
 */
export function jsonItems(value: unknown, path: string, label = "Item", options?: JsonSourceOptions): Source[] {
  const list = getPath(value, path);
  if (list === undefined) {
    throw new FeedError("json", `Nothing at path "${path}"`);
  }
  if (!Array.isArray(list)) {
    throw new FeedError("json", `Expected an array at path "${path}", got ${list === null ? "null" : typeof list}`);
  }
  return list.map((item, i) => ({ label: itemLabel(label, i + 1), text: jsonToText(item, options) }));
}
