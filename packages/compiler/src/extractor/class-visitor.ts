import type { ClassDeclaration } from "ts-morph";
import type { RuntimeSchema, FieldDescriptor, FieldType } from "@sembl/core";
import {
  parseSchemaDecorator,
  parseDescribeDecorator,
  parseConstrainDecorator,
  parseValuesFromDecorator,
} from "./decorator-parser.js";
import { resolveFieldType } from "./type-resolver.js";
import type { ExtractionContext, FieldScope } from "./extraction-context.js";

/**
 * Render a FieldType as something readable in a diagnostic.
 */
function describeKind(type: FieldType): string {
  return type.kind === "array" ? `${describeKind(type.items)}[]` : type.kind;
}

/**
 * Point a resolved field type at a runtime-resolved enum source.
 *
 * Only a string, or an array of strings, has values for a source to constrain.
 * Anywhere else the decorator is on the wrong field — a mistake worth hearing
 * about at build time rather than discovering as an annotation that did
 * nothing, so the type is left alone and the field still extracts.
 */
function applyValuesFrom(
  type: FieldType,
  sourceId: string,
  scope: FieldScope,
): FieldType {
  if (type.kind === "string") {
    return { kind: "dynamicEnum", sourceId };
  }
  if (type.kind === "array" && type.items.kind === "string") {
    return { kind: "array", items: { kind: "dynamicEnum", sourceId } };
  }
  scope.context.warn(
    scope,
    `@ValuesFrom("${sourceId}") applies to a string or string[] field, but this field ` +
      `resolved to ${describeKind(type)}. Leaving the type unchanged.`,
  );
  return type;
}

/**
 * Visit a class declaration and extract a RuntimeSchema if it has @Schema decorator.
 * Returns undefined if the class is not decorated with @Schema.
 *
 * Diagnostics and schemas synthesized for inline object types are collected
 * into `context` rather than thrown, so one questionable field does not stop
 * the rest of the extraction.
 */
export function visitClass(
  classDecl: ClassDeclaration,
  context: ExtractionContext,
): RuntimeSchema | undefined {
  const description = parseSchemaDecorator(classDecl);
  if (description === undefined) {
    return undefined;
  }

  const className = classDecl.getName();
  if (!className) {
    return undefined;
  }

  const fields: FieldDescriptor[] = [];

  for (const prop of classDecl.getProperties()) {
    const fieldDescription = parseDescribeDecorator(prop);
    if (fieldDescription === undefined) {
      continue;
    }

    const name = prop.getName();
    const isOptional = prop.hasQuestionToken();
    const scope: FieldScope = {
      className,
      propertyPath: name,
      node: prop,
      context,
    };

    let type = resolveFieldType(prop.getType(), scope);

    // @ValuesFrom rewrites the resolved type, so it has to run after the type
    // is known — it is the declared TS type that decides whether the source
    // can apply at all.
    const sourceId = parseValuesFromDecorator(prop, scope);
    if (sourceId !== undefined) {
      type = applyValuesFrom(type, sourceId, scope);
    }

    const constraints = parseConstrainDecorator(prop, scope);

    fields.push({
      name,
      description: fieldDescription,
      type,
      required: !isOptional,
      ...(constraints !== undefined ? { constraints } : {}),
    });
  }

  return {
    id: className,
    description,
    fields,
  };
}
