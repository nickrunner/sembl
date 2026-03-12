import { Project } from "ts-morph";
import type { RuntimeSchema, SchemaBundle } from "@sembl/core";
import { visitClass } from "./class-visitor.js";

export interface ExtractOptions {
  /** Glob patterns for source files */
  filePatterns: string[];
  /** Optional tsconfig.json path */
  tsconfigPath?: string;
}

/**
 * Extract all @Schema-decorated classes from the given source files.
 * Returns a SchemaBundle with all discovered schemas.
 */
export function extractSchemas(options: ExtractOptions): SchemaBundle {
  const project = new Project({
    tsConfigFilePath: options.tsconfigPath,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      experimentalDecorators: true,
      strict: true,
    },
  });

  // Add source files matching the patterns
  for (const pattern of options.filePatterns) {
    project.addSourceFilesAtPaths(pattern);
  }

  const schemas: Record<string, RuntimeSchema> = {};

  for (const sourceFile of project.getSourceFiles()) {
    for (const classDecl of sourceFile.getClasses()) {
      const schema = visitClass(classDecl);
      if (schema) {
        schemas[schema.id] = schema;
      }
    }
  }

  return { schemas };
}
