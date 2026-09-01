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
 * Property decorator bounding a field's value beyond its type.
 * No-op at runtime — parsed by the compiler from source AST.
 */
export function Constrain(constraints: FieldConstraints): PropertyDecorator {
  return function (_target, _propertyKey) {};
}

/**
 * Property decorator marking a field's legal values as coming from a runtime
 * taxonomy rather than the source tree. The `sourceId` is passed to the
 * caller's EnumResolver at coercion time.
 * No-op at runtime — parsed by the compiler from source AST.
 */
export function ValuesFrom(sourceId: string): PropertyDecorator {
  return function (_target, _propertyKey) {};
}
