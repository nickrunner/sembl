import type { Type } from "ts-morph";
import type { FieldDescriptor, FieldType } from "@sembl/core";
import { synthesizedSchemaId, type FieldScope } from "./extraction-context.js";

/**
 * Report a type the schema contract cannot express and fall back to a string.
 *
 * The fallback keeps the rest of the extraction going, but the warning is the
 * point: a field silently mistyped as a string still builds, still validates,
 * and only shows up as a wrong extraction at runtime.
 */
function reportUnsupported(
  type: Type,
  scope: FieldScope,
  reason: string,
): FieldType {
  scope.context.warn(
    scope,
    `unsupported type \`${type.getText(scope.node)}\` — ${reason}. Falling back to string.`,
  );
  return { kind: "string" };
}

/**
 * Build a schema for an anonymous object type (`{ description: string }`) and
 * register it so it is emitted like any hand-written one.
 *
 * Without this an inline type resolves to an id no schema answers to, and the
 * field reaches the model as an object with no properties.
 */
function resolveInlineObjectType(type: Type, scope: FieldScope): FieldType {
  const properties = type.getProperties();
  if (properties.length === 0) {
    // An index signature declares no properties to extract, and FieldType has
    // no map kind to express one. The contract is frozen, so there is nothing
    // correct to emit — only something to say.
    const isMap =
      type.getStringIndexType() !== undefined ||
      type.getNumberIndexType() !== undefined;
    return reportUnsupported(
      type,
      scope,
      isMap
        ? "a map with an index signature has no FieldType equivalent, so its entries cannot be " +
            "described to the model; declare a @Schema class with the keys you expect, or take " +
            "the value as a JSON string and parse it yourself"
        : "an object type with no properties has nothing to extract",
    );
  }

  const fields: FieldDescriptor[] = properties.map((property) => {
    const name = property.getName();
    return {
      name,
      // Members of an inline type carry no @Describe, so the owning field's
      // description is the only semantics the model gets for them.
      description: "",
      type: resolveFieldType(property.getTypeAtLocation(scope.node), {
        ...scope,
        propertyPath: `${scope.propertyPath}.${name}`,
      }),
      required: !property.isOptional(),
    };
  });

  // Hash the resolved fields rather than the source text: type text can embed
  // absolute import paths, which would make the id differ between machines.
  const id = synthesizedSchemaId(
    scope,
    JSON.stringify(fields.map((f) => [f.name, f.required, f.type])),
  );
  scope.context.registerSynthesizedSchema({
    id,
    description: `Inline object type declared at ${scope.className}.${scope.propertyPath}.`,
    fields,
  });
  return { kind: "object", nestedSchemaId: id };
}

/**
 * Resolve a TypeScript type to a FieldType descriptor.
 *
 * Maps TS types to the schema type system: string, number, boolean, array,
 * object, enum. Anything the contract cannot express is reported through
 * `scope.context` rather than quietly coerced.
 */
export function resolveFieldType(type: Type, scope: FieldScope): FieldType {
  // Optional and nullable fields arrive as unions with undefined/null. The
  // question mark already carries optionality, so resolve the value type.
  if (type.isUnion()) {
    const members = type
      .getUnionTypes()
      .filter((t) => !t.isUndefined() && !t.isNull());

    if (members.length === 1) {
      return resolveFieldType(members[0], scope);
    }

    if (members.length === 0) {
      return reportUnsupported(type, scope, "there is no value type to extract");
    }

    if (members.every((t) => t.isStringLiteral())) {
      return {
        kind: "enum",
        values: members.map((t) => t.getLiteralValue() as string),
      };
    }

    // `boolean` is modelled as `true | false`, so an optional boolean would
    // otherwise look like a mixed union and fall through to the fallback.
    if (members.every((t) => t.isBoolean() || t.isBooleanLiteral())) {
      return { kind: "boolean" };
    }

    // A numeric enum, or a union of number literals, widens to number:
    // FieldType has no numeric enum kind to narrow it to.
    if (members.every((t) => t.isNumber() || t.isNumberLiteral())) {
      return { kind: "number" };
    }

    return reportUnsupported(
      type,
      scope,
      "a union mixing several kinds of value has no single FieldType; split it into " +
        "separate fields, or narrow it to one kind",
    );
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
    return { kind: "array", items: resolveFieldType(elementType, scope) };
  }

  if (type.isEnum()) {
    const members = type
      .getUnionTypes()
      .map((t) => t.getLiteralValue())
      .filter((v): v is string => typeof v === "string");
    if (members.length > 0) {
      return { kind: "enum", values: members };
    }
    return reportUnsupported(
      type,
      scope,
      "its members are not string values, so they cannot be offered to the model as an enum",
    );
  }

  if (type.isObject()) {
    const symbol = type.getSymbol() ?? type.getAliasSymbol();
    const typeName = symbol?.getName();
    if (typeName && typeName !== "__type" && typeName !== "Object") {
      // Assume a named object type is another @Schema class. Whether it really
      // is one cannot be known until every file has been visited, so record it
      // for the check in reportUnresolvedNestedSchemas.
      scope.context.recordNestedReference(
        scope,
        typeName,
        type.getText(scope.node),
      );
      return { kind: "object", nestedSchemaId: typeName };
    }
    return resolveInlineObjectType(type, scope);
  }

  return reportUnsupported(
    type,
    scope,
    "it maps to none of string, number, boolean, array, enum, or a @Schema class",
  );
}
