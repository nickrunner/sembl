# Changelog

All notable changes to the SEMBL packages are recorded here. The four
publishable packages (`@sembl/core`, `@sembl/compiler`,
`@sembl/provider-anthropic`, `@sembl/provider-openai`) move in lockstep, so one
entry covers a release.

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
