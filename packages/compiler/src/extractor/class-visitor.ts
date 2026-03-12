import type { ClassDeclaration } from "ts-morph";
import type { RuntimeSchema, FieldDescriptor } from "@sembl/core";
import { parseSchemaDecorator, parseDescribeDecorator } from "./decorator-parser.js";
import { resolveFieldType } from "./type-resolver.js";

/**
 * Visit a class declaration and extract a RuntimeSchema if it has @Schema decorator.
 * Returns undefined if the class is not decorated with @Schema.
 */
export function visitClass(
  classDecl: ClassDeclaration,
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
    const type = prop.getType();

    fields.push({
      name,
      description: fieldDescription,
      type: resolveFieldType(type),
      required: !isOptional,
    });
  }

  return {
    id: className,
    description,
    fields,
  };
}
