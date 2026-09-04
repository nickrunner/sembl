# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sembl is a TypeScript library for semantic schema extraction and LLM-powered coercion. Define TypeScript classes with `@Schema`/`@Describe` decorators, extract them at compile time into runtime schemas, then use an LLM to coerce unstructured user input into typed, validated data.

## Build & Development Commands

```bash
pnpm install          # Install all workspace dependencies
pnpm build            # Build all packages (tsup, ESM output)
pnpm test             # Run all tests (Vitest)
pnpm lint             # Type-check all packages (tsc --noEmit)
pnpm -r dev           # Watch mode for all packages
```

Run a single test file:
```bash
pnpm vitest run packages/core/src/__tests__/coerce.test.ts
```

Run the compiler CLI example:
```bash
pnpm -C packages/examples extract
# equivalent to: sembl extract --input src/schemas --output src/generated
```

## Architecture

**Monorepo** using pnpm workspaces with these packages:

### @sembl/core
Runtime library. Key areas:
- **`schema/`** — `RuntimeSchema`, `FieldDescriptor`, `FieldType` definitions; JSON Schema conversion; `SchemaRegistry` for runtime lookup; `define.ts` builds schemas at runtime (`defineSchema`, `field`, `Infer`) with output identical to the compiler's
- **`coerce/`** — `coerce<T>()` and `partialCoerce<T>()` send schema + user input to an LLM provider and validate the response. `Coercible<T>` provides a fluent chainable API (via `sembl()`) that implements `PromiseLike`
- **`provider/`** — `Provider` interface that LLM implementations must satisfy
- **`decorators.ts`** — `@Schema` and `@Describe` are no-ops at runtime; they exist for compile-time extraction only
- **`validation/`** — `validateStrict()` (all required fields) and `validatePartial()` (only present fields)
- **`tracing/`** — Span-based tracing with pluggable sinks

### @sembl/compiler
Build-time tool that reads TypeScript source files with ts-morph, finds `@Schema`/`@Describe` decorators, and emits `RuntimeSchema` constants as `.schema.ts` files plus a bundle index.
- **`extractor/`** — AST pipeline: `ast-extractor` → `class-visitor` → `decorator-parser` → `type-resolver`
- **`generator/`** — `schema-emitter` outputs generated files
- **`cli/`** — Commander.js CLI exposed as the `sembl` binary: `extract` (schemas from decorated classes) and `eval` (runs `@sembl/testing` fixtures against a config module)

### @sembl/provider-openai
OpenAI provider implementing the `Provider` interface. Converts `RuntimeSchema` to OpenAI's strict JSON Schema format and uses structured outputs via `chat.completions`.

### @sembl/source-html
Zero-dependency HTML → text for extraction: title and meta tags, then JSON-LD, then body text, so head-keeping truncation preserves the structured parts.

### @sembl/testing
Node-only test support: `RecordingProvider` / `ReplayProvider` (request/response pairs on disk, keyed by a hash of what reached the model) and the eval harness behind `sembl eval`.

### @sembl/examples (private)
Twelve runnable examples under `src/examples/`, one per feature, over fictional listings in `data/`. `src/support/provider.ts` picks Anthropic or OpenAI from the env and wraps it in `replayOrRecord` so runs are recorded under `recordings/` (gitignored). `pnpm --filter @sembl/examples demo [n]`.

## Key Patterns

- **Coercion pipeline**: build system prompt → convert schema to JSON Schema → call LLM → parse JSON → validate → return typed result or throw `CoerceError`
- **FieldType system**: `string | number | boolean | enum | array | object`. Objects reference nested schemas by ID.
- **Decorators are compile-time only**: `@Schema("description")` and `@Describe("description")` are extracted by the compiler, not reflected at runtime
- **Tests use mock providers**: Define inline `RuntimeSchema` objects and mock `Provider` implementations; no LLM calls in tests

## TypeScript Configuration

- Target/module: ES2022, strict mode, `experimentalDecorators: true`
- All packages build with tsup to ESM with `.d.ts` generation
