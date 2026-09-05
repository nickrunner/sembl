import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type PropertyDeclaration,
  type Decorator,
} from "ts-morph";
import type { FieldConstraints } from "@sembl/core";
import { FIELD_FORMATS } from "@sembl/core";
import type { FieldScope } from "./extraction-context.js";

/**
 * Every key `FieldConstraints` allows, with the literal kind its value must be.
 *
 * Typed against `FieldConstraints` on purpose: if core adds or renames a
 * constraint, this table stops compiling instead of silently rejecting the new
 * key as unknown.
 */
const CONSTRAINT_KEYS: Record<
  keyof Required<FieldConstraints>,
  "number" | "string"
> = {
  maxLength: "number",
  minLength: "number",
  minimum: "number",
  maximum: "number",
  minItems: "number",
  maxItems: "number",
  pattern: "string",
  format: "string",
};

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

/**
 * Read a number written directly in source.
 *
 * A negative bound is a prefix minus applied to a numeric literal rather than
 * a literal of its own, so it needs unwrapping.
 */
function readNumberLiteral(node: Node): number | undefined {
  if (Node.isNumericLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    if (Node.isNumericLiteral(operand)) {
      const operator = node.getOperatorToken();
      if (operator === SyntaxKind.MinusToken) {
        return -operand.getLiteralValue();
      }
      if (operator === SyntaxKind.PlusToken) {
        return operand.getLiteralValue();
      }
    }
  }
  return undefined;
}

/**
 * Read a string written directly in source.
 */
function readStringLiteral(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  return undefined;
}

/**
 * Read one `key: value` pair of a @Constrain object literal into `constraints`.
 * Returns true if a value was accepted.
 */
function readConstraintEntry(
  property: Node,
  constraints: FieldConstraints,
  scope: FieldScope,
): boolean {
  if (!Node.isPropertyAssignment(property)) {
    // A shorthand (`{ maxLength }`), a spread (`{ ...shared }`), or a method
    // all resolve through a binding the compiler never evaluates.
    scope.context.warn(
      scope,
      `@Constrain entry \`${property.getText()}\` is not a \`key: value\` pair of ` +
        `compile-time constants and cannot be read from source. Skipping it.`,
    );
    return false;
  }

  const nameNode = property.getNameNode();
  if (!Node.isIdentifier(nameNode) && !Node.isStringLiteral(nameNode)) {
    scope.context.warn(
      scope,
      `@Constrain key \`${nameNode.getText()}\` is computed and cannot be read from source. Skipping it.`,
    );
    return false;
  }

  const key = nameNode.getText().replace(/^["']|["']$/g, "");
  if (!Object.prototype.hasOwnProperty.call(CONSTRAINT_KEYS, key)) {
    scope.context.warn(
      scope,
      `@Constrain key "${key}" is not a FieldConstraints property. ` +
        `Expected one of: ${Object.keys(CONSTRAINT_KEYS).join(", ")}. Skipping it.`,
    );
    return false;
  }

  const expected = CONSTRAINT_KEYS[key as keyof typeof CONSTRAINT_KEYS];
  const initializer = property.getInitializerOrThrow();
  const value =
    expected === "number"
      ? readNumberLiteral(initializer)
      : readStringLiteral(initializer);

  if (value === undefined) {
    scope.context.warn(
      scope,
      `@Constrain value for "${key}" is \`${initializer.getText()}\`, which is not ` +
        `a ${expected} literal the compiler can read from source. Skipping it.`,
    );
    return false;
  }

  if (key === "format" && !(FIELD_FORMATS as readonly string[]).includes(value as string)) {
    scope.context.warn(
      scope,
      `@Constrain format "${String(value)}" is not a known format. ` +
        `Expected one of: ${FIELD_FORMATS.join(", ")}. Skipping it.`,
    );
    return false;
  }

  (constraints as Record<string, number | string>)[key] = value;
  return true;
}

/**
 * Extract the @Constrain bounds from a property declaration.
 *
 * The decorator's argument has to be an inline object literal: decorators are
 * never evaluated, so a value that is not written out in source cannot be
 * resolved. Unreadable and unknown entries are warned about and skipped
 * individually, so one bad bound does not discard the rest.
 *
 * Returns undefined if there is no @Constrain decorator, or if nothing in it
 * could be read.
 */
export function parseConstrainDecorator(
  propDecl: PropertyDeclaration,
  scope: FieldScope,
): FieldConstraints | undefined {
  const decorator = propDecl.getDecorator("Constrain");
  if (!decorator) {
    return undefined;
  }

  const args = decorator.isDecoratorFactory() ? decorator.getArguments() : [];
  const argument = args[0];
  if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
    scope.context.warn(
      scope,
      `@Constrain expects an inline object literal of compile-time constants, but ` +
        `${argument === undefined ? "it was called with no argument" : `was given \`${argument.getText()}\``}. ` +
        `Ignoring the decorator.`,
    );
    return undefined;
  }

  const constraints: FieldConstraints = {};
  let accepted = 0;
  for (const property of argument.getProperties()) {
    if (readConstraintEntry(property, constraints, scope)) {
      accepted += 1;
    }
  }

  return accepted > 0 ? constraints : undefined;
}

/**
 * Extract the enum source id from a property's @ValuesFrom decorator.
 *
 * Returns undefined if there is no @ValuesFrom decorator, or if its argument
 * is not a string literal.
 */
export function parseValuesFromDecorator(
  propDecl: PropertyDeclaration,
  scope: FieldScope,
): string | undefined {
  const decorator = propDecl.getDecorator("ValuesFrom");
  if (!decorator) {
    return undefined;
  }

  const sourceId = getDecoratorStringArg(decorator);
  if (sourceId === undefined) {
    scope.context.warn(
      scope,
      `@ValuesFrom expects a string literal naming the enum source, which the caller ` +
        `resolves at coercion time. Ignoring the decorator.`,
    );
    return undefined;
  }
  return sourceId;
}
