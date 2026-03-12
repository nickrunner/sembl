export { extractSchemas } from "./extractor/ast-extractor.js";
export type { ExtractOptions } from "./extractor/ast-extractor.js";
export { emitSchemas } from "./generator/schema-emitter.js";
export { visitClass } from "./extractor/class-visitor.js";
export { parseSchemaDecorator, parseDescribeDecorator } from "./extractor/decorator-parser.js";
export { resolveFieldType } from "./extractor/type-resolver.js";
export type {
  SchemaAnnotation,
  FieldAnnotation,
  CompilerConfig,
  ExtractionResult,
} from "./types.js";
