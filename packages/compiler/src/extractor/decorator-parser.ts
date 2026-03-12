import type { ClassDeclaration, PropertyDeclaration, Decorator } from "ts-morph";

/**
 * Extract the string argument from a decorator call expression.
 * e.g. @Schema("some description") → "some description"
 */
function getDecoratorStringArg(decorator: Decorator): string | undefined {
  if (!decorator.isDecoratorFactory()) {
    return undefined;
  }
  const args = decorator.getArguments();
  if (args.length === 0) {
    return undefined;
  }
  const arg = args[0];
  // Strip quotes from string literal
  const text = arg.getText();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  // Handle template literals
  if (text.startsWith("`") && text.endsWith("`")) {
    return text.slice(1, -1);
  }
  return undefined;
}

/**
 * Extract the @Schema description from a class declaration.
 * Returns undefined if the class doesn't have a @Schema decorator.
 */
export function parseSchemaDecorator(
  classDecl: ClassDeclaration,
): string | undefined {
  const decorator = classDecl.getDecorator("Schema");
  if (!decorator) {
    return undefined;
  }
  return getDecoratorStringArg(decorator);
}

/**
 * Extract the @Describe description from a property declaration.
 * Returns undefined if the property doesn't have a @Describe decorator.
 */
export function parseDescribeDecorator(
  propDecl: PropertyDeclaration,
): string | undefined {
  const decorator = propDecl.getDecorator("Describe");
  if (!decorator) {
    return undefined;
  }
  return getDecoratorStringArg(decorator);
}
