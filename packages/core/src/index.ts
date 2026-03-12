// Schema types
export type {
  FieldType,
  FieldDescriptor,
  RuntimeSchema,
  SchemaBundle,
} from "./schema/types.js";

// Schema utilities
export {
  runtimeSchemaToJsonSchema,
  toOpenAIJsonSchema,
} from "./schema/json-schema.js";
export { SchemaRegistry } from "./schema/registry.js";

// Decorators
export { Schema, Describe } from "./decorators.js";

// Utility types
export type { DeepPartial } from "./types/deep-partial.js";

// Errors
export { CoerceError } from "./errors/coerce-error.js";
export type { FieldValidationIssue } from "./errors/coerce-error.js";

// Provider types
export type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
} from "./provider/types.js";

// Coerce API
export { coerce, partialCoerce } from "./coerce/coerce.js";
export type { CoerceOptions } from "./coerce/coerce.js";

// Fluent API
export { sembl, Coercible } from "./coerce/coercible.js";
export { SemblConfig } from "./coerce/config.js";
export type { SemblGlobalConfig, SemblCallConfig } from "./coerce/config.js";

// Prompt builder
export { buildPrompt } from "./coerce/prompt-builder.js";

// Validation
export { validateStrict, validatePartial } from "./coerce/validator.js";

// Tracing
export type {
  TraceEvent,
  TraceSpan,
  TraceSink,
  TraceContext,
} from "./tracing/types.js";
export { Tracer } from "./tracing/tracer.js";
export { ConsoleSink } from "./tracing/console-sink.js";
