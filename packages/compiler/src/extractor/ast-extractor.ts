import { Project, ScriptTarget } from "ts-morph";
import type { RuntimeSchema } from "@sembl/core";
import { visitClass } from "./class-visitor.js";
import { createExtractionContext } from "./extraction-context.js";
import type { ExtractionResult } from "../types.js";

export interface ExtractOptions {
  /** Glob patterns for source files */
  filePatterns: string[];
  /** Optional tsconfig.json path */
  tsconfigPath?: string;
}

/**
 * Extract all @Schema-decorated classes from the given source files.
 *
 * Returns the schemas alongside any warnings raised while resolving them —
 * unsupported field types, annotations that could not be read. Extraction
 * never throws on a bad field, so the warnings are the only signal that the
 * emitted schemas are not what the source described.
 */
export function extractSchemas(options: ExtractOptions): ExtractionResult {
  const project = new Project({
    tsConfigFilePath: options.tsconfigPath,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      experimentalDecorators: true,
      strict: true,
      // Without a target the default lib is ES5, so anything newer — `Map`,
      // `Set` — resolves to `any` and lands in the unsupported-type warning as
      // "any", naming a type the author never wrote.
      target: ScriptTarget.ES2022,
    },
  });

  // Add source files matching the patterns
  for (const pattern of options.filePatterns) {
    project.addSourceFilesAtPaths(pattern);
  }

  const context = createExtractionContext();
  const schemas: Record<string, RuntimeSchema> = {};

  for (const sourceFile of project.getSourceFiles()) {
    for (const classDecl of sourceFile.getClasses()) {
      const schema = visitClass(classDecl, context);
      if (schema) {
        schemas[schema.id] = schema;
      }
    }
  }

  // Schemas synthesized for inline object types are emitted like any other, so
  // the prompt builder and the JSON Schema converter can resolve them by id.
  for (const [id, schema] of Object.entries(context.synthesizedSchemas)) {
    schemas[id] = schema;
  }

  // Only now is the full set of ids known, so a nested reference to a class
  // declared in a file visited later is not mistaken for a dangling one.
  context.reportUnresolvedNestedSchemas(new Set(Object.keys(schemas)));

  return { schemas, warnings: [...context.warnings] };
}
