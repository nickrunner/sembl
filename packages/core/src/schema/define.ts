import type {
  FieldConstraints,
  FieldDescriptor,
  FieldType,
  RuntimeSchema,
  SchemaBundle,
} from "./types.js";

/**
 * A field under construction. `T` is the TypeScript type a coerced value
 * will have; `Required` is whether the model must supply it.
 *
 * Builders are immutable: every method returns a new one, so a builder can be
 * reused across schemas.
 */
export interface FieldBuilder<T, Required extends boolean = true> {
  /** Phantom carrier for `T`; never set at runtime. */
  readonly __type?: T;
  readonly type: FieldType;
  readonly description: string;
  readonly required: Required;
  readonly constraints?: FieldConstraints;
  /** Nested schemas this field's type refers to, keyed by id. */
  readonly schemas: Readonly<Record<string, RuntimeSchema>>;
  /** The model may leave this field out. */
  optional(): FieldBuilder<T, false>;
  /**
   * Wrap the type in an array. String and number bounds already on the
   * builder apply to each element, exactly as they do for a decorated
   * `string[]`; item-count bounds go here.
   */
  array(constraints?: FieldConstraints): FieldBuilder<T[], Required>;
  /** Replace the description. */
  describe(description: string): FieldBuilder<T, Required>;
  /** Add bounds, merged over any already set. */
  constrain(constraints: FieldConstraints): FieldBuilder<T, Required>;
  /** The descriptor this builder produces under a given name. */
  toDescriptor(name: string): FieldDescriptor;
}

/**
 * A schema built at runtime. It *is* a `RuntimeSchema`, so it goes anywhere
 * one is accepted, and it also carries the bundle of every schema it refers
 * to (itself included), which the coercion functions use when no bundle is
 * passed explicitly.
 */
export interface DefinedSchema<T> extends RuntimeSchema {
  /** Phantom carrier for `T`; never set at runtime. */
  readonly __type?: T;
  readonly bundle: SchemaBundle;
}

/** The TypeScript type of a defined schema or a field builder. */
export type Infer<S> = S extends DefinedSchema<infer T>
  ? T
  : S extends FieldBuilder<infer T, boolean>
    ? T
    : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type FieldValue<B> = B extends FieldBuilder<infer T, boolean> ? T : never;

type RequiredKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<unknown, true> ? K : never;
}[keyof F];

type OptionalKeys<F> = {
  [K in keyof F]: F[K] extends FieldBuilder<unknown, false> ? K : never;
}[keyof F];

/** The object type a set of field builders describes. */
export type InferFields<F> = Simplify<
  { [K in RequiredKeys<F>]: FieldValue<F[K]> } & { [K in OptionalKeys<F>]?: FieldValue<F[K]> }
>;

function mergeConstraints(
  a: FieldConstraints | undefined,
  b: FieldConstraints | undefined,
): FieldConstraints | undefined {
  if (!a && !b) return undefined;
  const merged = { ...(a ?? {}), ...(b ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

class Field<T, Required extends boolean> implements FieldBuilder<T, Required> {
  declare readonly __type?: T;

  constructor(
    readonly type: FieldType,
    readonly description: string,
    readonly required: Required,
    readonly constraints: FieldConstraints | undefined,
    readonly schemas: Readonly<Record<string, RuntimeSchema>>,
  ) {}

  optional(): FieldBuilder<T, false> {
    return new Field<T, false>(this.type, this.description, false, this.constraints, this.schemas);
  }

  array(constraints?: FieldConstraints): FieldBuilder<T[], Required> {
    return new Field<T[], Required>(
      { kind: "array", items: this.type },
      this.description,
      this.required,
      mergeConstraints(this.constraints, constraints),
      this.schemas,
    );
  }

  describe(description: string): FieldBuilder<T, Required> {
    return new Field<T, Required>(this.type, description, this.required, this.constraints, this.schemas);
  }

  constrain(constraints: FieldConstraints): FieldBuilder<T, Required> {
    return new Field<T, Required>(
      this.type,
      this.description,
      this.required,
      mergeConstraints(this.constraints, constraints),
      this.schemas,
    );
  }

  toDescriptor(name: string): FieldDescriptor {
    return {
      name,
      description: this.description,
      type: this.type,
      required: this.required,
      ...(this.constraints ? { constraints: { ...this.constraints } } : {}),
    };
  }
}

function leaf<T>(type: FieldType, description: string, constraints?: FieldConstraints): FieldBuilder<T, true> {
  return new Field<T, true>(type, description, true, mergeConstraints(undefined, constraints), {});
}

/**
 * Field builders. Each takes the field's description first — the semantics
 * are the point — and returns a required field; call `.optional()` to let
 * the model leave it out.
 */
export const field = {
  string(description: string, constraints?: FieldConstraints): FieldBuilder<string, true> {
    return leaf<string>({ kind: "string" }, description, constraints);
  },
  number(description: string, constraints?: FieldConstraints): FieldBuilder<number, true> {
    return leaf<number>({ kind: "number" }, description, constraints);
  },
  boolean(description: string): FieldBuilder<boolean, true> {
    return leaf<boolean>({ kind: "boolean" }, description);
  },
  /** A closed set of string values known at build time. */
  enum<const V extends string>(values: readonly V[], description: string): FieldBuilder<V, true> {
    if (values.length === 0) {
      throw new RangeError("An enum field needs at least one value");
    }
    return leaf<V>({ kind: "enum", values: [...values] }, description);
  },
  /**
   * A closed set of string values resolved at coercion time from a named
   * source — the runtime equivalent of `@ValuesFrom`.
   */
  valuesFrom(
    sourceId: string,
    description: string,
    constraints?: FieldConstraints,
  ): FieldBuilder<string, true> {
    return leaf<string>({ kind: "dynamicEnum", sourceId }, description, constraints);
  },
  /** A nested object shaped by another defined schema. */
  object<S extends DefinedSchema<unknown>>(schema: S, description: string): FieldBuilder<Infer<S>, true> {
    return new Field<Infer<S>, true>(
      { kind: "object", nestedSchemaId: schema.id },
      description,
      true,
      undefined,
      { ...schema.bundle.schemas },
    );
  },
  /** An array of whatever another builder describes; same as `item.array()`. */
  array<T, R extends boolean>(
    item: FieldBuilder<T, R>,
    constraints?: FieldConstraints,
  ): FieldBuilder<T[], R> {
    return item.array(constraints);
  },
};

/**
 * Define a schema at runtime, without decorators or a compile step.
 *
 * Produces exactly what `sembl extract` would emit for the equivalent
 * decorated class — the same descriptors in the same order — so the two ways
 * of defining a schema are interchangeable. The result carries a bundle of
 * every schema it refers to, so nested objects work without assembling one
 * by hand.
 *
 * ```ts
 * const Address = defineSchema("Address", "Where a property is.", {
 *   city: field.string("City or municipality."),
 *   zip: field.string("Postal code.").optional(),
 * });
 * const Listing = defineSchema("Listing", "A short-term rental listing.", {
 *   name: field.string("Display name.", { maxLength: 40 }),
 *   amenities: field.valuesFrom("amenities", "What the property offers.").array({ maxItems: 5 }),
 *   address: field.object(Address, "Where the property is.").optional(),
 * });
 * type Listing = Infer<typeof Listing>;
 * ```
 */
export function defineSchema<F extends Record<string, FieldBuilder<unknown, boolean>>>(
  id: string,
  description: string,
  fields: F,
): DefinedSchema<InferFields<F>> {
  if (!id.trim()) {
    throw new RangeError("A schema needs a non-empty id");
  }

  const schemas: Record<string, RuntimeSchema> = {};
  const descriptors: FieldDescriptor[] = [];

  for (const [name, builder] of Object.entries(fields)) {
    descriptors.push(builder.toDescriptor(name));
    for (const [nestedId, nested] of Object.entries(builder.schemas)) {
      const existing = schemas[nestedId];
      if (existing && JSON.stringify(existing) !== JSON.stringify(nested)) {
        throw new Error(
          `Schema "${id}" refers to two different schemas with the id "${nestedId}"`,
        );
      }
      schemas[nestedId] = nested;
    }
  }

  if (schemas[id]) {
    throw new Error(`Schema "${id}" refers to another schema with its own id`);
  }

  // The bundle holds plain schemas only, so it stays acyclic and serializable;
  // the defined schema is a separate object that carries the bundle.
  const plain: RuntimeSchema = { id, description, fields: descriptors };
  schemas[id] = plain;

  return { ...plain, bundle: { schemas } } as DefinedSchema<InferFields<F>>;
}

/** The bundle a schema carries, when it was made by {@link defineSchema}. */
export function bundleOf(schema: RuntimeSchema): SchemaBundle | undefined {
  const candidate = (schema as Partial<DefinedSchema<unknown>>).bundle;
  return candidate && typeof candidate === "object" && "schemas" in candidate ? candidate : undefined;
}
