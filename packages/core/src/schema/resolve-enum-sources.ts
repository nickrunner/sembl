import type { FieldType, RuntimeSchema, SchemaBundle } from "./types.js";
import type { EnumResolver, ResolvedEnums } from "./enum-source.js";

/**
 * An enum source that could not be turned into a usable set of legal values.
 */
export interface EnumSourceFailure {
  /** The source id that failed */
  sourceId: string;
  /** Why it failed: the resolver threw, or it produced no values */
  reason: "threw" | "empty";
  /** The thrown value, when `reason` is "threw" */
  cause?: unknown;
  /**
   * Whether a required field depends on this source. A field counts as
   * required only if every object on the path to it is also required — an
   * unreachable field cannot make a coercion fail.
   */
  required: boolean;
  /** Field paths that reference this source, for error messages */
  paths: string[];
}

/**
 * The outcome of resolving every enum source a schema reaches.
 */
export interface EnumResolution {
  /** Legal values for each source that resolved successfully */
  enums: ResolvedEnums;
  /** Sources that threw or produced nothing */
  failures: EnumSourceFailure[];
}

/** How a single enum source is reached from the root schema. */
export interface EnumSourceUsage {
  /** Whether the source is reachable through an unbroken chain of required fields */
  required: boolean;
  /** Field paths that reference this source */
  paths: string[];
}

/**
 * Walk a FieldType, recording every dynamic enum source it reaches.
 *
 * `visiting` is the stack of schema ids on the current path rather than a set
 * of everything seen, so a schema referenced twice in different branches is
 * still walked twice while a schema that references itself terminates.
 */
function collectFromType(
  type: FieldType,
  path: string,
  required: boolean,
  bundle: SchemaBundle | undefined,
  visiting: Set<string>,
  usages: Map<string, EnumSourceUsage>,
): void {
  switch (type.kind) {
    case "dynamicEnum": {
      const existing = usages.get(type.sourceId);
      if (existing) {
        // A source is required-critical if *any* of its uses is required.
        existing.required ||= required;
        existing.paths.push(path);
      } else {
        usages.set(type.sourceId, { required, paths: [path] });
      }
      break;
    }
    case "array":
      collectFromType(type.items, `${path}[]`, required, bundle, visiting, usages);
      break;
    case "object": {
      const nested = bundle?.schemas[type.nestedSchemaId];
      if (nested && !visiting.has(nested.id)) {
        collectFromSchema(nested, path, required, bundle, visiting, usages);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Walk a schema's fields, recording every dynamic enum source they reach.
 */
function collectFromSchema(
  schema: RuntimeSchema,
  parentPath: string,
  parentRequired: boolean,
  bundle: SchemaBundle | undefined,
  visiting: Set<string>,
  usages: Map<string, EnumSourceUsage>,
): void {
  visiting.add(schema.id);
  for (const field of schema.fields) {
    const path = parentPath ? `${parentPath}.${field.name}` : field.name;
    collectFromType(
      field.type,
      path,
      parentRequired && field.required,
      bundle,
      visiting,
      usages,
    );
  }
  visiting.delete(schema.id);
}

/**
 * Collect the distinct dynamic enum source ids a schema reaches, directly or
 * through its bundle, along with whether each is reachable through a chain of
 * required fields.
 */
export function collectEnumSources(
  schema: RuntimeSchema,
  bundle?: SchemaBundle,
): Map<string, EnumSourceUsage> {
  const usages = new Map<string, EnumSourceUsage>();
  collectFromSchema(schema, "", true, bundle, new Set(), usages);
  return usages;
}

/**
 * Resolve every dynamic enum source a schema reaches, calling `resolver` once
 * per distinct source id and awaiting all of them concurrently.
 *
 * Resolution never throws on the caller's behalf. A source whose resolver
 * throws, or which yields no values, is reported in `failures` and left out of
 * `enums` — downstream that means the field widens to a free-form string.
 * Widening a *required* field is a silent correctness hole, so callers are
 * expected to treat a failure with `required: true` as fatal; `coerce` and
 * `partialCoerce` do exactly that.
 */
export async function resolveEnumSources(
  schema: RuntimeSchema,
  resolver: EnumResolver,
  bundle?: SchemaBundle,
): Promise<EnumResolution> {
  const usages = collectEnumSources(schema, bundle);

  const enums: Record<string, readonly string[]> = {};
  const failures: EnumSourceFailure[] = [];

  await Promise.all(
    [...usages].map(async ([sourceId, usage]) => {
      try {
        const values = await resolver(sourceId);
        if (!values || values.length === 0) {
          failures.push({ sourceId, reason: "empty", ...usage });
          return;
        }
        enums[sourceId] = values;
      } catch (cause) {
        failures.push({ sourceId, reason: "threw", cause, ...usage });
      }
    }),
  );

  // Map iteration order is insertion order, but Promise.all settles in
  // completion order — sort so failures are reported deterministically.
  failures.sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  return { enums, failures };
}
