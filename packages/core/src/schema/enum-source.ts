/**
 * Legal values for every `dynamicEnum` source needed by a coercion, keyed by
 * `sourceId`.
 */
export interface ResolvedEnums {
  readonly [sourceId: string]: readonly string[];
}

/**
 * Supplies the legal values for a `dynamicEnum` source at coercion time.
 *
 * Called once per distinct `sourceId` reachable from the target schema. Async
 * so it can hit a database, a CMS, or a cache; the caller owns any caching —
 * SEMBL does not memoize across calls.
 *
 * ```ts
 * const enumResolver: EnumResolver = async (sourceId) => {
 *   const docs = await cms.taxonomy(sourceId);
 *   return docs.map((d) => d.slug);
 * };
 * ```
 */
export type EnumResolver = (
  sourceId: string,
) => readonly string[] | Promise<readonly string[]>;
