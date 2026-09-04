import type {
  FieldConstraints,
  FieldDescriptor,
  FieldType,
  RuntimeSchema,
  SchemaBundle,
} from "../schema/types.js";
import type { ResolvedEnums } from "../schema/enum-source.js";
import type { FieldValidationIssue } from "../errors/coerce-error.js";
import { validateStrict, validatePartial } from "./validator.js";

/**
 * What to do with a present field that fails validation.
 *
 * - `"throw"` — the whole coercion fails with a `CoerceError`. The default.
 * - `"drop"` — remove the offending value and carry on. What gets removed is
 *   the smallest thing that can go: an array element, an optional field, or
 *   (in a partial coercion) any top-level field. A violation that only a
 *   required field can absorb is not droppable and still throws.
 * - `"clamp"` — where a bound makes a clamp meaningful (`maxLength`,
 *   `minimum`, `maximum`, `maxItems`), cut the value down to the bound; where
 *   it does not (a type mismatch, a bad enum value, `minLength`, `pattern`),
 *   fall back to dropping.
 *
 * A form pre-fill usually wants `"drop"` or `"clamp"`: losing twenty good
 * fields because one came back out of range is the wrong failure unit when a
 * person is about to review the result anyway.
 */
export type InvalidFieldPolicy = "throw" | "drop" | "clamp";

/** What was done about a validation issue. */
export type IssueResolution = "dropped" | "clamped";

/** A validation issue and how it was resolved without a repair round. */
export interface ResolvedIssue extends FieldValidationIssue {
  /** What was done about it. */
  resolution: IssueResolution;
  /**
   * The path that was actually changed. For a drop this can be an ancestor of
   * `path` — the nearest array element or optional field that could absorb
   * the removal.
   */
  resolvedPath: string;
  /** The value now at `resolvedPath`, for a clamp. */
  replacement?: unknown;
}

/** Options for {@link resolveIssues}. */
export interface ResolveIssuesOptions {
  /** Bundle for nested schemas, the same one the validator was given. */
  bundle?: SchemaBundle;
  /** Legal values for dynamic enum sources, the same ones the validator used. */
  resolvedEnums?: ResolvedEnums;
  /**
   * Which validator judged the data. In a partial coercion every top-level
   * field is optional by definition, so any of them can be dropped.
   */
  mode: "coerce" | "partialCoerce";
  /** The policy to apply. `"throw"` resolves nothing. */
  policy: InvalidFieldPolicy;
}

/** The outcome of resolving a set of issues. */
export interface ResolveIssuesResult {
  /** The data after every drop and clamp. The input is never mutated. */
  data: Record<string, unknown>;
  /** Issues the policy could act on, in the order they were handled. */
  resolved: ResolvedIssue[];
  /** Issues nothing could absorb — a required field, at every level. */
  unresolved: FieldValidationIssue[];
}

type PathSegment = { kind: "field"; name: string } | { kind: "index"; index: number };

/** Parse a validator path like `address.tags[2].label` into segments. */
function parsePath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    if (match[1] !== undefined) {
      segments.push({ kind: "field", name: match[1] });
    } else {
      segments.push({ kind: "index", index: Number(match[2]) });
    }
  }
  return segments;
}

function formatPath(segments: readonly PathSegment[]): string {
  let out = "";
  for (const segment of segments) {
    if (segment.kind === "index") {
      out += `[${segment.index}]`;
    } else {
      out += out.length === 0 ? segment.name : `.${segment.name}`;
    }
  }
  return out;
}

/** How many segments deep a path reaches. */
function pathDepth(path: string): number {
  return parsePath(path).length;
}

/** Whether `path` is `prefix` itself or something nested inside it. */
function isWithin(path: string, prefix: string): boolean {
  return (
    path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)
  );
}

/**
 * A path segment paired with what the schema says about it. `descriptor` is
 * the field a `field` segment names; an `index` segment carries the field
 * whose array it indexes into, because element constraints live there.
 */
interface DescribedSegment {
  segment: PathSegment;
  descriptor: FieldDescriptor;
}

/**
 * Walk the schema alongside a path. Returns null when the path names
 * something the schema does not describe — a field the model invented, or a
 * nested schema missing from the bundle — since nothing can be said about
 * whether it is safe to remove.
 */
function describePath(
  segments: readonly PathSegment[],
  schema: RuntimeSchema,
  bundle: SchemaBundle | undefined,
): DescribedSegment[] | null {
  const described: DescribedSegment[] = [];
  let currentSchema: RuntimeSchema | undefined = schema;
  let currentType: FieldType | undefined;
  let currentField: FieldDescriptor | undefined;

  for (const segment of segments) {
    if (segment.kind === "field") {
      if (!currentSchema) return null;
      const field: FieldDescriptor | undefined = currentSchema.fields.find(
        (f) => f.name === segment.name,
      );
      if (!field) return null;
      described.push({ segment, descriptor: field });
      currentField = field;
      currentType = field.type;
      currentSchema = undefined;
    } else {
      if (!currentType || currentType.kind !== "array" || !currentField) return null;
      described.push({ segment, descriptor: currentField });
      currentType = currentType.items;
      currentSchema = undefined;
    }
    if (currentType?.kind === "object") {
      currentSchema = bundle?.schemas[currentType.nestedSchemaId];
    }
  }
  return described;
}

function getAt(data: Record<string, unknown>, segments: readonly PathSegment[]): unknown {
  let current: unknown = data;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current =
      segment.kind === "field"
        ? (current as Record<string, unknown>)[segment.name]
        : (current as unknown[])[segment.index];
  }
  return current;
}

function setAt(
  data: Record<string, unknown>,
  segments: readonly PathSegment[],
  value: unknown,
): void {
  const parent = getAt(data, segments.slice(0, -1));
  const last = segments[segments.length - 1];
  if (parent === null || typeof parent !== "object" || !last) return;
  if (last.kind === "field") {
    (parent as Record<string, unknown>)[last.name] = value;
  } else {
    (parent as unknown[])[last.index] = value;
  }
}

function deleteAt(data: Record<string, unknown>, segments: readonly PathSegment[]): void {
  const parent = getAt(data, segments.slice(0, -1));
  const last = segments[segments.length - 1];
  if (parent === null || typeof parent !== "object" || !last) return;
  if (last.kind === "field") {
    delete (parent as Record<string, unknown>)[last.name];
  } else if (Array.isArray(parent)) {
    parent.splice(last.index, 1);
  }
}

/**
 * The nearest thing on the path that can be removed without violating the
 * schema: an array element, an optional field, or in partial mode any
 * top-level field. Null when everything up to the root is required.
 */
function findDropTarget(
  described: readonly DescribedSegment[],
  mode: "coerce" | "partialCoerce",
): PathSegment[] | null {
  for (let depth = described.length - 1; depth >= 0; depth--) {
    const { segment, descriptor } = described[depth];
    const droppable =
      segment.kind === "index" ||
      !descriptor.required ||
      (mode === "partialCoerce" && depth === 0);
    if (droppable) {
      return described.slice(0, depth + 1).map((d) => d.segment);
    }
  }
  return null;
}

/**
 * The bounds that apply to the value at the end of a path. A field's own
 * constraints apply to its value; for an array element the parent field's
 * string and number bounds apply, but not its item counts.
 */
function constraintsAt(described: readonly DescribedSegment[]): FieldConstraints | undefined {
  const last = described[described.length - 1];
  if (!last?.descriptor.constraints) return undefined;
  if (last.segment.kind === "field") return last.descriptor.constraints;
  const { minItems: _min, maxItems: _max, ...elementConstraints } = last.descriptor.constraints;
  return elementConstraints;
}

/**
 * Cut a value down to its bounds where that produces something the caller
 * would recognise as the same value, shortened. Returns undefined when no
 * clamp applies or the value already satisfies every clampable bound.
 */
function clampValue(value: unknown, constraints: FieldConstraints): unknown {
  if (typeof value === "string") {
    if (constraints.maxLength !== undefined && value.length > constraints.maxLength) {
      return value.slice(0, constraints.maxLength);
    }
    return undefined;
  }
  if (typeof value === "number") {
    if (constraints.minimum !== undefined && value < constraints.minimum) {
      return constraints.minimum;
    }
    if (constraints.maximum !== undefined && value > constraints.maximum) {
      return constraints.maximum;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    if (constraints.maxItems !== undefined && value.length > constraints.maxItems) {
      return value.slice(0, constraints.maxItems);
    }
    return undefined;
  }
  return undefined;
}

/**
 * Apply an {@link InvalidFieldPolicy} to a validated response.
 *
 * Works one action at a time and re-validates after each, so a clamp that
 * leaves a value still invalid (too long *and* failing its pattern, say) falls
 * through to a drop, and removing an array element never leaves a stale
 * index behind. Each action strictly shrinks the data, so the loop ends.
 *
 * Pure: the input data is cloned, never mutated.
 */
export function resolveIssues(
  data: Record<string, unknown>,
  issues: readonly FieldValidationIssue[],
  schema: RuntimeSchema,
  options: ResolveIssuesOptions,
): ResolveIssuesResult {
  const { bundle, resolvedEnums, mode, policy } = options;
  if (policy === "throw" || issues.length === 0) {
    return { data, resolved: [], unresolved: [...issues] };
  }

  const validate = mode === "coerce" ? validateStrict : validatePartial;
  const current = structuredClone(data);
  const resolved: ResolvedIssue[] = [];
  let pending: FieldValidationIssue[] = [...issues];

  while (pending.length > 0) {
    let acted = false;

    // Deepest paths first: removing a bad element can also fix its array's
    // item count, whereas acting on the array first would throw away the
    // good elements alongside the bad one.
    const ordered = [...pending].sort((a, b) => pathDepth(b.path) - pathDepth(a.path));

    for (const issue of ordered) {
      const segments = parsePath(issue.path);
      const described = describePath(segments, schema, bundle);
      if (!described || described.length === 0) continue;

      if (policy === "clamp") {
        const constraints = constraintsAt(described);
        const replacement = constraints
          ? clampValue(getAt(current, segments), constraints)
          : undefined;
        if (replacement !== undefined) {
          setAt(current, segments, replacement);
          resolved.push({
            ...issue,
            resolution: "clamped",
            resolvedPath: issue.path,
            replacement,
          });
          acted = true;
          break;
        }
      }

      const target = findDropTarget(described, mode);
      if (target) {
        const resolvedPath = formatPath(target);
        deleteAt(current, target);
        // Every pending issue inside the removed subtree went with it.
        for (const covered of pending) {
          if (isWithin(covered.path, resolvedPath)) {
            resolved.push({ ...covered, resolution: "dropped", resolvedPath });
          }
        }
        acted = true;
        break;
      }
    }

    if (!acted) break;
    pending = validate(current, schema, bundle, { resolvedEnums });
  }

  return { data: current, resolved, unresolved: pending };
}
