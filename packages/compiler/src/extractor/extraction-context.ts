import { createHash } from "node:crypto";
import type { Node } from "ts-morph";
import type { RuntimeSchema } from "@sembl/core";

/**
 * Where a field sits in the source, carried through type resolution and
 * decorator parsing.
 *
 * Every diagnostic names the class and the property, because a warning that
 * only says "unsupported type" sends the reader hunting through the whole
 * input directory for it.
 */
export interface FieldScope {
  /** Name of the @Schema class that owns the field. */
  className: string;
  /** Property name, dotted through synthesized inline objects. */
  propertyPath: string;
  /**
   * Declaration the type was read from. Members of an anonymous object type
   * have no declaration of their own to resolve against, so they are typed
   * relative to this node.
   */
  node: Node;
  /** Collector for diagnostics and synthesized schemas. */
  context: ExtractionContext;
}

/**
 * An `object` field type pointing at another schema by id, remembered so the
 * id can be checked once every source file has been visited.
 */
interface NestedReference {
  className: string;
  propertyPath: string;
  nestedSchemaId: string;
  /** Source text of the type, for a diagnostic the reader can act on. */
  typeText: string;
}

/**
 * Accumulates everything an extraction produces beyond the schemas themselves:
 * diagnostics, schemas synthesized for anonymous object types, and the nested
 * schema references that can only be validated once all files are visited.
 */
export interface ExtractionContext {
  /** Diagnostics raised so far, in discovery order. */
  readonly warnings: readonly string[];
  /** Schemas synthesized for anonymous inline object types, keyed by id. */
  readonly synthesizedSchemas: Readonly<Record<string, RuntimeSchema>>;
  /** Record a diagnostic against a field. */
  warn(scope: FieldScope, message: string): void;
  /** Add a schema synthesized for an inline object type. */
  registerSynthesizedSchema(schema: RuntimeSchema): void;
  /** Note that a field points at `nestedSchemaId`, to be checked later. */
  recordNestedReference(
    scope: FieldScope,
    nestedSchemaId: string,
    typeText: string,
  ): void;
  /**
   * Warn about every recorded reference whose target is not among
   * `knownSchemaIds`. Call once, after all classes have been visited.
   */
  reportUnresolvedNestedSchemas(knownSchemaIds: ReadonlySet<string>): void;
}

/**
 * Create an empty {@link ExtractionContext} for a single extraction run.
 */
export function createExtractionContext(): ExtractionContext {
  const warnings: string[] = [];
  const synthesizedSchemas: Record<string, RuntimeSchema> = {};
  const nestedReferences: NestedReference[] = [];

  return {
    warnings,
    synthesizedSchemas,

    warn(scope, message) {
      warnings.push(`${scope.className}.${scope.propertyPath}: ${message}`);
    },

    registerSynthesizedSchema(schema) {
      synthesizedSchemas[schema.id] = schema;
    },

    recordNestedReference(scope, nestedSchemaId, typeText) {
      nestedReferences.push({
        className: scope.className,
        propertyPath: scope.propertyPath,
        nestedSchemaId,
        typeText,
      });
    },

    reportUnresolvedNestedSchemas(knownSchemaIds) {
      for (const reference of nestedReferences) {
        if (knownSchemaIds.has(reference.nestedSchemaId)) {
          continue;
        }
        // A named object type that is not a @Schema class — a `Date`, a `Map`,
        // a plain interface — resolves to an id nothing in the bundle answers
        // to, and emits as an object with no properties. Nothing fails; the
        // field just comes back empty at runtime.
        warnings.push(
          `${reference.className}.${reference.propertyPath}: type \`${reference.typeText}\` ` +
            `resolves to nested schema "${reference.nestedSchemaId}", which is not a ` +
            `@Schema-decorated class in this extraction. It will emit as an object with ` +
            `no properties. Decorate it with @Schema if it is yours to change, or use a type ` +
            `the contract supports — a \`Date\`, for instance, extracts as an ISO-8601 string.`,
        );
      }
    },
  };
}

/**
 * Derive the id of a schema synthesized from an anonymous object type.
 *
 * The id becomes a filename and an exported binding in the generated output
 * (`<id>.schema.ts`, `<id>Schema`), so it has to be a valid identifier. The
 * path prefix keeps generated files traceable back to the declaration they
 * came from; the digest of the resolved shape makes the id collision-resistant
 * against a hand-written @Schema class and stable across runs and machines —
 * it is derived from the resolved fields, never from absolute source paths.
 */
export function synthesizedSchemaId(
  scope: FieldScope,
  structuralSignature: string,
): string {
  const path = `${scope.className}_${scope.propertyPath}`.replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const digest = createHash("sha256")
    .update(structuralSignature)
    .digest("hex")
    .slice(0, 8);
  return `${path}__${digest}`;
}
