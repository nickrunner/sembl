import type { RuntimeSchema } from "./types.js";

/**
 * What a resolver is told about the source it is asked for, beyond its id:
 * which schema is being coerced and where in it the source is used. One
 * resolver can then serve several taxonomies, log which field asked, or
 * refuse a source that a required field depends on but it cannot vouch for.
 */
export interface EnumResolverContext {
  sourceId: string;
  /** The schema being coerced — the root, not a nested one. */
  schema: RuntimeSchema;
  /** Whether a chain of required fields reaches the source. */
  required: boolean;
  /** Dotted paths of every field drawing from the source, e.g. `address.country`. */
  paths: string[];
}

/**
 * Resolves the legal values of a `@ValuesFrom` source at coercion time.
 * Called once per distinct source id per coercion; caching is the caller's.
 * The context argument is optional to accept — a resolver that only needs
 * the id can ignore it.
 */
export type EnumResolver = (
  sourceId: string,
  context: EnumResolverContext,
) => readonly string[] | Promise<readonly string[]>;

/** Resolved values keyed by source id. */
export type ResolvedEnums = Readonly<Record<string, readonly string[]>>;
