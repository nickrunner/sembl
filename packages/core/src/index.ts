// Schema types
export type {
  FieldType,
  FieldConstraints,
  FieldDescriptor,
  RuntimeSchema,
  SchemaBundle,
} from "./schema/types.js";
export type { EnumResolver, EnumResolverContext, ResolvedEnums } from "./schema/enum-source.js";

// Schema utilities
export {
  runtimeSchemaToJsonSchema,
  toOpenAIJsonSchema,
} from "./schema/json-schema.js";
export type {
  JsonSchemaDialect,
  JsonSchemaOptions,
} from "./schema/json-schema.js";
export {
  resolveEnumSources,
  collectEnumSources,
} from "./schema/resolve-enum-sources.js";
export type {
  EnumResolution,
  EnumSourceFailure,
  EnumSourceUsage,
} from "./schema/resolve-enum-sources.js";
export { SchemaRegistry } from "./schema/registry.js";

// Formats
export { FIELD_FORMATS, validateFormat, describeFormat, formatToJsonSchema } from "./schema/formats.js";
export type { FieldFormat } from "./schema/formats.js";

// Runtime schema definition (no decorators, no compile step)
export { defineSchema, field, bundleOf } from "./schema/define.js";
export type { DefinedSchema, FieldBuilder, Infer, InferFields } from "./schema/define.js";

// Decorators
export { Schema, Describe, Constrain, ValuesFrom } from "./decorators.js";

// Utility types
export type { DeepPartial } from "./types/deep-partial.js";

// Errors
export { CoerceError } from "./errors/coerce-error.js";
export type { FieldValidationIssue } from "./errors/coerce-error.js";
export { EnumResolutionError } from "./errors/enum-resolution-error.js";

// Provider types
export type {
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderTurn,
  ProviderUsage,
} from "./provider/types.js";

// Coerce API
export {
  coerce,
  partialCoerce,
  coerceDetailed,
  partialCoerceDetailed,
  coerceWithProvenance,
  partialCoerceWithProvenance,
  primeCache,
} from "./coerce/coerce.js";
export type {
  CoerceOptions,
  PreprocessSource,
  CoerceDetails,
  CoerceUsage,
  PrimedPrefix,
  PrimeCacheOptions,
} from "./coerce/coerce.js";

// Batches
export { coerceMany } from "./coerce/coerce-many.js";
export type { CoerceManyOptions, CoerceManyResult, RetryOptions } from "./coerce/coerce-many.js";

// Input budgeting
export { budgetSources } from "./coerce/budget.js";
export type { TruncatePolicy, TruncationRecord, BudgetResult } from "./coerce/budget.js";

// Sources
export {
  toSources,
  renderSources,
  isSource,
  isCoerceInput,
  SOURCE_INSTRUCTIONS,
} from "./coerce/sources.js";
export type { Source, CoerceInput } from "./coerce/sources.js";

// Provenance
export {
  toProvenanceSchema,
  splitProvenance,
  provenanceInstructions,
  PROVENANCE_INSTRUCTIONS,
} from "./coerce/provenance.js";
export type {
  FieldConfidence,
  FieldProvenance,
  ProvenanceOptions,
  ProvenanceResult,
} from "./coerce/provenance.js";

// Invalid-field policy
export { resolveIssues } from "./coerce/resolve-issues.js";
export type {
  InvalidFieldPolicy,
  IssueResolution,
  ResolvedIssue,
  ResolveIssuesOptions,
  ResolveIssuesResult,
} from "./coerce/resolve-issues.js";

// Repair
export { buildRepairInput, buildRepairCorrection } from "./coerce/repair.js";

// Fluent API
export { sembl, Coercible } from "./coerce/coercible.js";
export { SemblConfig } from "./coerce/config.js";
export type { SemblGlobalConfig, SemblCallConfig } from "./coerce/config.js";

// Prompt builder
export { buildPrompt, normalizeInstructions } from "./coerce/prompt-builder.js";
export type { PromptOptions } from "./coerce/prompt-builder.js";

// Validation
export { validateStrict, validatePartial } from "./coerce/validator.js";
export type { ValidationOptions } from "./coerce/validator.js";

// Tracing
export type {
  TraceEvent,
  TraceSpan,
  TraceSink,
  TraceContext,
} from "./tracing/types.js";
export { Tracer } from "./tracing/tracer.js";
export { ConsoleSink } from "./tracing/console-sink.js";
