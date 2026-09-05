# Changelog

All notable changes to the SEMBL packages are recorded here. The publishable
packages (`@sembl/core`, `@sembl/compiler`, the two providers, `@sembl/testing`
and every `@sembl/source-*` package) move in lockstep, so one entry covers a
release.

## Unreleased

Input modalities:

- Image and PDF sources in core. `Source` is `TextSource | ImageSource |
  DocumentSource`, with guards, `renderContent()` for ordered content blocks,
  `ProviderRequest.content`, and `Provider.supportsImages` /
  `supportsDocuments`; core refuses a binary source for a provider without
  support before any call. `maxImages` / `maxDocuments` cap a run with a
  `sourcesDropped` trace event. Both providers render image and document
  blocks (OpenAI takes PDF bytes only). Recordings key on a hash of binary
  content; eval fixtures accept `{ "image": … }` and `{ "document": … }`.
  Text-only prompts are byte-for-byte unchanged.
- New package `@sembl/source-pdf` (pdf.js, Apache-2.0; needs Node 22.13):
  `pdfToText`, `pdfSource`, `pdfSources` one per page, metadata first,
  `pdfInfo` to detect scans, `PdfError` codes.
- New package `@sembl/source-table` (exceljs, MIT): `tableRows` one source
  per row for `coerceMany`, `tableSource` for a whole sheet, and the
  import-wizard flow — `mappingSchema`, `mappingInput`, `applyMapping` —
  where the model coerces a column mapping once and code applies it.
- New package `@sembl/source-email` (postal-mime, MIT-0): `emailSource`,
  `emailSources` with attachment routing, `threadSources` for threads and
  mbox, quoted replies and signatures stripped.
- New package `@sembl/source-audio` (`openai` SDK for the bundled
  transcriber): pluggable `Transcriber`, `audioSource` with `[HH:MM:SS]`
  lines, `audioSources` chunking, `evidenceTimestamp`, `withTranscriptCache`,
  `OpenAITranscriber`, `FakeTranscriber`.
- New package `@sembl/source-docx` (no dependencies): `.docx` and `.odt` with
  headings, lists, tables, footnotes; `docxSources` one per section;
  tracked changes resolved.
- New package `@sembl/source-feed` (no dependencies): `jsonSource` /
  `jsonItems`, `xmlSource` / `xmlItems`, `feedItems` for RSS and Atom,
  `icsSource` / `icsEvents`, and `availabilityWindows` with recurrence
  expanded and DST-correct.
- New package `@sembl/source-image` (no dependencies): `sniffImageType`,
  `imageDimensions`, `extractExif` (date, GPS, orientation, camera; never
  throws), `imageSource` with size limits and typed errors, `imageSources`
  adding a photo-metadata text source beside the image, `fetchImages` for a
  harvested gallery with count and size caps and an injectable fetch, and
  the `ImageResizer` seam with `prepareImages`. Companion
  `@sembl/source-image-sharp` (sharp): `SharpResizer` downscales to 1568px,
  auto-orients, strips metadata, converts formats; HEIC only where the
  installed libvips can decode it.
- Every source package returns `TextSource`, so `.text` stays typed.
- Examples 14–21, one per modality.

## 0.5.0

Block 3 of the Stays requests:

- Multi-turn repair. `ProviderRequest.history` carries the rejected output
  as an assistant turn and the correction as a user turn; both bundled
  providers render it natively (a tool call and an error tool result on
  Anthropic, assistant and user messages on OpenAI) and declare
  `supportsHistory`. Empty-result retries use the same turns. A provider
  without it still gets the correction folded into the input. Recordings
  key on the history, so a repair call never collides with the call it
  repairs.
- `EnumResolver` receives a context: the schema, whether a required field
  depends on the source, and the field paths that use it.
- `@sembl/source-html`: `htmlSources` returns the structured data and the
  body text as two labelled sources so the budget never cuts the JSON-LD;
  `extractImages` harvests OpenGraph, JSON-LD and `<img>` images with junk
  and duplicates dropped.

## 0.4.0

From the Stays integration:

- The Anthropic provider no longer sends `temperature` unless configured
  (Claude 5 models reject it), disables adaptive thinking for Claude 5
  models so a forced tool call is accepted, and takes `thinking` and
  `requestOverrides`. The OpenAI provider also sends `temperature` only when
  set.
- `coerceDetailed` and `partialCoerceDetailed` return `issues` and `usage`
  without provenance; provenance results and every `coerceMany` result now
  carry `usage` too.
- `coerceMany` accepts any iterable, async ones included; `primeCache:
  "eager"` warms the cache with one small call instead of a solo item; a
  caller can `primeCache()` themselves while fetching and pass `primed`.
  `onItem` is typed, and every span of an item carries `itemIndex` and
  `itemLabel`.
- `retryOnEmpty` re-asks when a non-empty input yields no fields, and the
  prompt says a stated default (`1`, `0`, `false`) is still a value.
- Provenance's `source` is required whenever there are several sources.


Block 2 of the Stays requests:

- `format` on `@Constrain` / `field.*` constraints: `url`, `email`, `date`,
  `datetime`, `iso-country`, `us-state`, `us-state-name`, `currency`. Stated
  in the prompt, validated locally, emitted as JSON Schema `format` or
  `pattern` in the standard dialect. The compiler reads it and warns on an
  unknown format.
- `provenanceFields` on the provenance coercions, and `provenance:
  string[]` on `coerceMany`, annotate only the listed fields.
- `Source.maxChars` caps one source before the total budget is shared.

## 0.3.0

- `instructions` on every coercion, `sembl()` and the global config: caller
  hints for this extraction, rendered as their own section at the end of the
  system prompt so they stay outside the source data boundary. Reaches
  repair calls and is part of the recording key.

## 0.2.1

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
