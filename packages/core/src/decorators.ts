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
