/**
 * Resolves a taxonomy identifier to the set of legal values for a field.
 *
 * Sources are opaque to SEMBL: the id is whatever the schema author wrote in
 * `@ValuesFrom("...")`, and the caller decides how to turn it into values
 * (a CMS fetch, a database query, a static map). Called at most once per
 * distinct source id per coercion.
 */
export type EnumResolver = (
  sourceId: string,
) => readonly string[] | Promise<readonly string[]>;

/**
 * The legal values for every enum source that resolved successfully,
 * keyed by source id.
 *
 * A source id absent from this map is *unresolved* — the field it backs falls
 * back to a free-form string. Successful resolution always yields a non-empty
 * array; an empty result is treated as a failure, not as "no legal values",
 * because a field with zero legal values is unsatisfiable.
 */
export type ResolvedEnums = Readonly<Record<string, readonly string[]>>;
