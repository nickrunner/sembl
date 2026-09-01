import type { FieldConstraints } from "./schema/types.js";

/**
 * Class decorator marking a schema class with a semantic description.
 * No-op at runtime — parsed by the compiler from source AST.
 */
export function Schema(description: string): ClassDecorator {
  return function (target) {
    return target;
  };
}

/**
 * Property decorator providing a field-level semantic description.
 * No-op at runtime — parsed by the compiler from source AST.
 */
export function Describe(description: string): PropertyDecorator {
  return function (_target, _propertyKey) {};
}

/**
 * Property decorator bounding a field's legal values — lengths, numeric
 * ranges, array sizes, a pattern.
 *
 * Takes an object literal of compile-time constants; the compiler reads it
 * from source, so computed expressions are not supported.
 *
 * ```ts
 * @Describe("Display name for the listing.")
 * @Constrain({ maxLength: 40 })
 * name!: string;
 * ```
 *
 * No-op at runtime — parsed by the compiler from source AST.
 */
export function Constrain(constraints: FieldConstraints): PropertyDecorator {
  return function (_target, _propertyKey) {};
}

/**
 * Property decorator declaring that a field's legal values come from a named
 * source resolved at coercion time rather than from the source tree — a CMS
 * taxonomy, a database enum table.
 *
 * Applies to a string field or to the element type of a string array. The
 * caller supplies an `EnumResolver` that maps `sourceId` to the legal values.
 *
 * ```ts
 * @Describe("Amenities the property offers.")
 * @ValuesFrom("amenities")
 * amenities!: string[];
 * ```
 *
 * No-op at runtime — parsed by the compiler from source AST.
 */
export function ValuesFrom(sourceId: string): PropertyDecorator {
  return function (_target, _propertyKey) {};
}
