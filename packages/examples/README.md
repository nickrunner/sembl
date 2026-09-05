# @sembl/examples

Twenty-one runnable examples, one per feature, against a fictional set of rental
listings in `data/`.

```sh
pnpm install && pnpm build            # from the repo root
pnpm --filter @sembl/examples demo    # all of them
pnpm --filter @sembl/examples demo 06 # one, by number
pnpm --filter @sembl/examples demo batch eval   # several, by a word in the title
```

Put `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `packages/examples/.env` (or the
environment) for the first run. Every model call is recorded under
`recordings/`, so later runs replay for free and work with no key at all;
only calls whose prompt, schema or input changed go live again.
`SEMBL_LIVE=1` skips recordings; `SEMBL_MODEL` overrides the model id.

| #  | What it shows                                                                 |
| -- | ----------------------------------------------------------------------------- |
| 01 | `coerce` vs `partialCoerce`, a `CoerceError`'s per-field issues, the fluent chain |
| 02 | `defineSchema` producing the exact output of `sembl extract`, and `Infer<>`   |
| 03 | `@Constrain` in the prompt, `@ValuesFrom` resolved through an `enumResolver`, `EnumResolutionError` |
| 04 | `onInvalidField`: throw, clamp, and drop on a deliberately damaged answer     |
| 05 | `maxRepairAttempts`: the model corrects its own rejected output               |
| 06 | Several labelled sources, provenance naming the source, an injection attempt  |
| 07 | `@sembl/source-html` on a page, `maxInputChars` with the `inputTruncated` event |
| 08 | `coerceMany` with a concurrency cap, progress, and per-item results           |
| 09 | Provenance driving a "needs review" flag                                      |
| 10 | `ConsoleSink` and a custom sink adding up token usage                         |
| 11 | `RecordingProvider` / `ReplayProvider` with a miss                            |
| 12 | The eval harness over `evals/listing`, with deltas against the previous run   |
| 13 | `instructions`: a per-call hint the schema can't carry, changing the result   |
| 14 | An image source: a listing read from a photo, provenance pointing into it, a text-only provider refused |
| 15 | `@sembl/source-pdf`: a brochure, one source per page, provenance naming the page |
| 16 | `@sembl/source-table`: CSV rows through `coerceMany`, then a coerced column mapping applied by code |
| 17 | `@sembl/source-email`: a handover thread, quoted replies stripped, attachments routed |
| 18 | `@sembl/source-audio`: a host's voice note transcribed with timestamps as evidence |
| 19 | `@sembl/source-docx`: handover notes, one source per section                  |
| 20 | `@sembl/source-feed`: an XML property feed through `coerceMany`, and an ICS calendar |
| 21 | `@sembl/source-image`: sniffing, EXIF as a metadata source beside the photo, a gallery fetched with limits, sharp resizing |

`pnpm --filter @sembl/examples eval` runs example 12's fixtures through the
`sembl eval` CLI instead, using `src/support/eval-config.ts` as the config.

`src/schemas/` holds decorated classes compiled by `sembl extract` at build
time; `src/support/listing-runtime.ts` is the same `Listing` built with
`defineSchema`. Example 02 checks that the two are identical.
