export { extractSchemas } from "./extractor/ast-extractor.js";
export type { ExtractOptions } from "./extractor/ast-extractor.js";
export { emitSchemas } from "./generator/schema-emitter.js";
export { visitClass } from "./extractor/class-visitor.js";
export {
  parseSchemaDecorator,
  parseDescribeDecorator,
  parseConstrainDecorator,
  parseValuesFromDecorator,
} from "./extractor/decorator-parser.js";
export { resolveFieldType } from "./extractor/type-resolver.js";
export {
  createExtractionContext,
  synthesizedSchemaId,
} from "./extractor/extraction-context.js";
export type {
  ExtractionContext,
  FieldScope,
} from "./extractor/extraction-context.js";
export type {
  SchemaAnnotation,
  FieldAnnotation,
  CompilerConfig,
  ExtractionResult,
} from "./types.js";
export { evalCommand } from "./cli/commands/eval.js";
export type { EvalCommandOptions, EvalCommandResult, EvalConfig } from "./cli/commands/eval.js";
