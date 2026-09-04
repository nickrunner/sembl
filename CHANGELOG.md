# Changelog

All notable changes to the SEMBL packages are recorded here. The publishable
packages (`@sembl/core`, `@sembl/compiler`, `@sembl/provider-anthropic`,
`@sembl/provider-openai`, `@sembl/source-html`, `@sembl/testing`) move in
lockstep, so one entry covers a release.

## Unreleased

- Fixed: the OpenAI provider rebuilt its JSON Schema without the resolved
  enum values, so `@ValuesFrom` fields were free-form strings on OpenAI and
  the model could answer "Hot tub" where the taxonomy said "hot-tub".
- `@sembl/examples` is now a suite of twelve examples, one per feature,
  recorded on first run and replayed afterwards.

## 0.2.0

- Eval harness in `@sembl/testing` (`runEval`, `loadFixtures`, `formatReport`,
  `diffReports`) and a `sembl eval` CLI command: per-field precision and
  recall over `{ input, expected }` fixtures, token usage, cost and latency
  percentiles, deltas against the previous run, replay support, and
  `--min-recall` / `--min-precision` gates.

- New package `@sembl/testing`: `RecordingProvider` writes request/response
  pairs to a directory keyed by what reached the model; `ReplayProvider`
  answers from them offline, throwing `ReplayMissError` on a miss unless a
  fallback provider records it. `replayOrRecord(dir, live?)` is the usual
  arrangement for tests that run with credentials locally and without in CI.

- `defineSchema` and `field` build a `RuntimeSchema` at runtime with no
  decorators or compile step, emitting exactly what `sembl extract` would for
  the equivalent class. A defined schema carries the bundle of every schema
  it refers to, which coercions use when none is passed, and `Infer<>` gives
  its TypeScript type.

- `coerceMany` runs a batch against one schema with a concurrency cap, one
  settled result per input in input order, a cache-priming first call, and
  a batch-wide backoff on retryable provider errors.

- `maxInputChars` caps the source text sent to the model, with `truncate`
  choosing which part of an over-budget source to cut and a `preprocess`
  hook that runs on each source first. Short sources keep their text; the
  cut lands on the long ones, is marked in place, and is traced as
  `inputTruncated`. `budgetSources` is exported.
- New package `@sembl/source-html`: HTML to readable text with the title,
  meta tags and JSON-LD ahead of the body, plus a `preprocessHtml()` hook.

- Coercions accept a string, a labelled `Source`, or a list of sources. Each
  is rendered as a delimited `<source>` block, the system prompt instructs the
  model to treat everything inside a block as data rather than instructions,
  and a closing tag inside a source is escaped so it cannot break out. With
  several sources, provenance gains `source`, the label a value was read
  from. `sembl()` passes sources through its first link untouched.

- `onInvalidField: "throw" | "drop" | "clamp"` on every coercion, `sembl()`,
  and the global config. `"drop"` removes an invalid optional value (or any
  top-level value in a partial coercion) instead of failing the whole
  extraction; `"clamp"` cuts strings, numbers and arrays to their bounds
  first. Required fields still throw. Absorbed issues skip the repair loop,
  come back as `issues` on the provenance results, and are traced. The
  resolver is exported as `resolveIssues` for callers using the validators
  directly.

- All packages now ship CommonJS alongside ESM, with `.d.cts` types for the
  `require` condition. The `sembl` CLI stays ESM-only.

## 0.1.0

Initial release.

- `@sembl/core`: `coerce`, `partialCoerce`, the fluent `sembl()` API, strict and
  partial validation, `@Constrain` field constraints, `@ValuesFrom` runtime enum
  sources, a repair loop for rejected responses, per-field provenance, and
  span-based tracing.
- `@sembl/compiler`: the `sembl extract` CLI that turns `@Schema` / `@Describe`
  classes into `RuntimeSchema` bundles.
- `@sembl/provider-anthropic`: forced tool-call structured output with prompt
  caching, retries, and typed errors.
- `@sembl/provider-openai`: structured outputs via `chat.completions`.
