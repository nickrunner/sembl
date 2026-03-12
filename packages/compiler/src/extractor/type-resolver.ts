import type { Type } from "ts-morph";
import type { FieldType } from "@sembl/core";

/**
 * Resolve a TypeScript type to a FieldType descriptor.
 * Maps TS types to the schema type system: string, number, boolean, array, object, enum.
 */
export function resolveFieldType(type: Type): FieldType {
  // Unwrap union types that include undefined (optional fields)
  if (type.isUnion()) {
    const nonUndefined = type.getUnionTypes().filter((t) => !t.isUndefined());
    if (nonUndefined.length === 1) {
      return resolveFieldType(nonUndefined[0]);
    }
    // If all remaining types are string literals, treat as enum
    if (nonUndefined.every((t) => t.isStringLiteral())) {
      return {
        kind: "enum",
        values: nonUndefined.map((t) => t.getLiteralValue() as string),
      };
    }
  }

  if (type.isString() || type.isStringLiteral()) {
    return { kind: "string" };
  }

  if (type.isNumber() || type.isNumberLiteral()) {
    return { kind: "number" };
  }

  if (type.isBoolean() || type.isBooleanLiteral()) {
    return { kind: "boolean" };
  }

  if (type.isArray()) {
    const elementType = type.getArrayElementTypeOrThrow();
    return { kind: "array", items: resolveFieldType(elementType) };
  }

  if (type.isEnum()) {
    const enumDecl = type.getSymbol()?.getDeclarations()?.[0];
    if (enumDecl) {
      // Try to get enum member values
      const members = type
        .getUnionTypes()
        .map((t) => t.getLiteralValue())
        .filter((v): v is string => typeof v === "string");
      if (members.length > 0) {
        return { kind: "enum", values: members };
      }
    }
    return { kind: "string" };
  }

  // Object / nested schema type
  if (type.isObject() && !type.isArray()) {
    const symbol = type.getSymbol() ?? type.getAliasSymbol();
    const typeName = symbol?.getName();
    if (typeName && typeName !== "__type" && typeName !== "Object") {
      return { kind: "object", nestedSchemaId: typeName };
    }
    return { kind: "object", nestedSchemaId: "unknown" };
  }

  // Default fallback
  return { kind: "string" };
}
