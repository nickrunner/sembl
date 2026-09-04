# Changelog

All notable changes to the SEMBL packages are recorded here. The four
publishable packages (`@sembl/core`, `@sembl/compiler`,
`@sembl/provider-anthropic`, `@sembl/provider-openai`) move in lockstep, so one
entry covers a release.

## Unreleased

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
