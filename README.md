# SEMBL

**Semantic coercion for TypeScript.** Describe what a type *means*, and turn
unstructured input — prose, scraped HTML, a third-party API payload — into a
validated instance of it.

```ts
const draft = await sembl(listingHtml).partialCoerceTo(StayDetailsSchema);
```

SEMBL is a schema compiler plus a thin runtime. You annotate ordinary
TypeScript classes with the *meaning* of each field; a build step extracts
those annotations into runtime schemas; at runtime an LLM provider does the
extraction and SEMBL validates the result against the schema you declared.

## Why not just call the model yourself?

Hand-written extraction prompts drift from the types they populate. SEMBL keeps
one source of truth — the decorated class — and derives the prompt, the JSON
Schema sent to the provider, and the validation from it. Rename a field or
sharpen a description and every downstream artifact follows.

## Install

```sh
pnpm add @sembl/core @sembl/provider-anthropic @anthropic-ai/sdk
pnpm add -D @sembl/compiler
```

Swap in `@sembl/provider-openai` (plus `openai`) if that's your provider. Both
provider packages take their SDK as a peer dependency, so your app owns the
version and, usually, the client instance.

Every package ships ESM and CommonJS with matching types, so `import` and
`require` both work. Only the `sembl` CLI binary is ESM-only.

## Quickstart

### 1. Describe the shape

Semantics live in the decorators. `@Schema` says what the type is for;
`@Describe` says what each field means. Optional (`?`) fields are the ones the
model is allowed to leave out.

```ts
// src/schemas/address.ts
import { Schema, Describe } from "@sembl/core";

@Schema("A real-world location where a person usually starts outdoor activities.")
export class Address {
  @Describe("Street number and street name.")
  street?: string;

  @Describe("City or municipality.")
  city!: string;

  @Describe("Postal code.")
  zip?: string;
}
```

Field types may be `string`, `number`, `boolean`, string-literal unions and
TypeScript `enum`s (both emitted as enums), arrays of any of those, and other
`@Schema` classes — nested or in arrays. Inline anonymous object types get a
nested schema synthesized for them.

Two more decorators bound what a field may hold:

```ts
@Schema("A short-term rental listing as a host would describe it.")
export class Listing {
  @Describe("Display name for the listing.")
  @Constrain({ maxLength: 40 })
  name!: string;

  @Describe("Amenities the property offers.")
  @ValuesFrom("amenities")
  @Constrain({ maxItems: 5 })
  amenities!: string[];
}
```

`@Constrain` takes lengths, numeric ranges, array sizes, and a pattern. On an
array field the string and number bounds apply to each element, so `string[]`
can carry both `maxItems` and `maxLength`.

`@ValuesFrom` says the legal values aren't in the source tree — they come from
a named source you resolve at coercion time. That's the shape a CMS taxonomy or
a database enum table actually has.

### 2. Compile them

```sh
npx sembl extract --input src/schemas --output src/generated
```

This walks the source AST — decorators are no-ops at runtime, so nothing is
reflected or evaluated — and emits one `<Name>.schema.ts` per class plus an
`index.ts` exporting a `SchemaBundle`. Generated output is build artifact:
check it into `.gitignore` and run `extract` before `build`.

### Or skip the compiler

Decorators need `experimentalDecorators`, an extraction step, and generated
files. If your domain types are interfaces, or you'd rather have no codegen
at all, build the same schemas at runtime:

```ts
import { defineSchema, field, type Infer } from "@sembl/core";

const Address = defineSchema("Address", "Where a property is.", {
  street: field.string("Street number and street name.").optional(),
  city: field.string("City or municipality."),
  zip: field.string("Postal code.").optional(),
});

const Listing = defineSchema("Listing", "A short-term rental listing as a host would describe it.", {
  name: field.string("Display name for the listing.", { maxLength: 40 }),
  amenities: field.valuesFrom("amenities", "Amenities the property offers.").array({ maxItems: 5 }),
  kind: field.enum(["house", "flat"], "The property's primary type.").optional(),
  address: field.object(Address, "Where the property is.").optional(),
});
type Listing = Infer<typeof Listing>;

const listing = await coerce<Listing>(input, { provider, schema: Listing });
```

Both paths emit identical `RuntimeSchema` output — the compiler's fixtures
round-trip through `defineSchema` in the test suite — so prompts and
validation don't care which one you used. A defined schema carries a bundle
of every schema it refers to, which the coercion functions pick up when you
don't pass one, and `Infer<>` yields the type the class would have had.

### 3. Coerce

```ts
import { sembl, SemblConfig, SchemaRegistry } from "@sembl/core";
import { AnthropicProvider } from "@sembl/provider-anthropic";
import { bundle } from "./generated/index.js";

const registry = new SchemaRegistry();
registry.registerBundle(bundle);

SemblConfig.configure({
  provider: new AnthropicProvider({ model: "claude-sonnet-5", apiKey }),
  bundle: registry.toBundle(),
  // Called once per distinct @ValuesFrom source per coercion. You own caching.
  enumResolver: async (sourceId) => (await cms.taxonomy(sourceId)).map((d) => d.slug),
});

const profile = await sembl(
  "I love cycling and running. I usually start from my place in Berlin, 10115.",
).partialCoerceTo<Profile>(registry.require("Profile"));
// → { activities: ["cycling", "running"], address: { city: "Berlin", zip: "10115" } }
```

## The two coercions

|                       | `coerce`                                         | `partialCoerce`                                   |
| --------------------- | ------------------------------------------------ | -------------------------------------------------- |
| Missing required field | throws `CoerceError`                             | allowed                                             |
| Wrong type on a present field | throws `CoerceError`                     | throws `CoerceError`                                |
| …with `onInvalidField: "drop"` | dropped if optional, else throws        | dropped                                             |
| …with `onInvalidField: "clamp"` | cut to its bound, else as `"drop"`     | cut to its bound, else dropped                      |
| Returns               | `T`                                              | `Partial<T>`, with `null`s stripped                 |
| Use for               | a value the next step depends on                 | pre-filling a form the user will review             |

`CoerceError.issues` is a `FieldValidationIssue[]` — `path`, `message`,
`received` — so a form can surface per-field problems rather than one opaque
failure. Violated `@Constrain` bounds and values outside a resolved
`@ValuesFrom` set are issues like any type mismatch.

By default one bad field fails the whole extraction. For a form pre-fill that
is the wrong failure unit — losing twenty good fields because `sleeps` came
back as `200` is worse than losing `sleeps` — so both coercions take an
`onInvalidField` policy:

```ts
const { data, provenance, issues } = await partialCoerceWithProvenance<Listing>(html, {
  provider,
  schema,
  onInvalidField: "clamp",
});
// issues → [{ path: "sleeps", resolution: "clamped", replacement: 20, … }]
```

`"drop"` removes the smallest thing that can go — an array element, an
optional field, or in `partialCoerce` any top-level field — and walks up from
a bad nested value to the nearest of those. `"clamp"` cuts a value down to its
`maxLength`, `minimum`, `maximum` or `maxItems` where that is meaningful and
drops it otherwise. A violation only a required field can absorb still throws
in either mode. Issues the policy absorbs never cost a repair round; the
provenance variants report them in `issues`, and every run records an
`issuesResolved` trace event. Set it per call, on `sembl()`, or globally via
`SemblConfig.configure`.

If a source backing a **required** field fails to resolve, both coercions throw
`EnumResolutionError` instead of quietly widening the field to a free-form
string — a corrupted taxonomy is not the same thing as a missing value. A
source backing only optional fields widens and records a trace event.

Both are also available as plain functions when you'd rather pass config
explicitly than configure a global:

```ts
import { coerce, partialCoerce } from "@sembl/core";

const address = await coerce<Address>(input, { provider, schema, bundle });
```

## Chaining

`sembl()` returns a thenable `Coercible`. Each link runs its own LLM call, with
the previous result serialized as the next input — so you can narrow through
intermediate shapes rather than asking one prompt to do everything:

```ts
const intent = await sembl(conversation)
  .partialCoerceTo(profileSchema)  // messy transcript → what we know about them
  .coerceTo(intentSchema);         // → what they're actually asking for
```

## Repairing a bad extraction

Messy input produces invalid output sometimes. Rather than losing the whole
extraction, hand the model its own rejected output and the reasons:

```ts
await coerce<Listing>(scrapedHtml, { provider, schema, maxRepairAttempts: 1 });
```

A repair costs an extra call only when validation actually failed, so the happy
path is untouched. It's off by default because it also multiplies worst-case
latency — but for extraction from scraped HTML or third-party payloads, `1` is
usually the right setting.

## More than one source

Real extraction often has several inputs for one target — an Airbnb page and
a Vrbo page for the same property, a PDF and the email it came with. Every
coercion takes a string, one labelled source, or a list of them:

```ts
const listing = await coerce<Listing>(
  [
    { label: "Airbnb listing", text: airbnbText },
    { label: "Vrbo listing", text: vrboText },
  ],
  { provider, schema },
);
```

Each source is rendered as its own delimited block in the user message, and
the system prompt tells the model that everything inside those blocks is data:
a scraped page reading "ignore previous instructions" is part of the text to
extract from, not an instruction. A closing tag inside a source is escaped so
no source can end its own block early. With several sources, provenance also
reports which one each value was read from (`provenance.name.source`).

## Batches

The realistic workload is N records against one schema. `coerceMany` owns
the loop, the concurrency cap and the backoff, and hands back one settled
result per input, in input order:

```ts
const results = await coerceMany<Partial<Listing>>(pages, {
  provider,
  schema,
  mode: "partialCoerce",
  onInvalidField: "clamp",
  concurrency: 4,
  onItem: (r) => progress.tick(r.index, r.ok),
});

for (const r of results) {
  if (r.ok) save(r.index, r.data, r.issues);
  else retryLater(r.index, r.error);
}
```

One failure never rejects the batch. The first item runs alone before the
rest fan out, so a provider that caches the prompt prefix writes it once and
every later item reads it (`primeCache: false` to skip). A retryable
provider error — a 429, an overload, a dropped connection — pauses the whole
batch rather than each item rediscovering the limit, with a delay that
doubles per consecutive failure and resets on success (`retry` tunes it).
Pass `provenance: true` for per-field provenance on every item, and a
`signal` to stop starting new items.

## Budgeting the input

Scraped HTML is routinely 60k+ characters. Rather than guessing a safe cap in
every caller, give the coercion one:

```ts
await coerce<Listing>(htmlSource(html, "Listing"), {
  provider,
  schema,
  maxInputChars: 40_000,
  truncate: "tail",            // cut the end (default); "head" keeps the end; "middle" keeps both ends
  preprocess: (source) => ...,  // runs on each source first — strip, redact, normalise
});
```

The budget covers all sources together. Every source that fits within an
equal share keeps its whole text; what those leave unused goes to the longer
ones, so a short email next to a long page is never touched. A cut is marked
in place with how much was omitted, and an `inputTruncated` trace event
records it, so truncation is never silent. Tokens vary by model; as a rule of
thumb English prose runs about four characters per token.

For pages, [`@sembl/source-html`](packages/source-html/README.md) turns HTML
into readable text with the title, meta tags and JSON-LD first, so the parts
most likely to hold clean facts are the ones that survive a cut.

## Knowing what to trust

A pre-filled form needs to distinguish what was read from the input from what
was guessed, so it can flag the guesses for review:

```ts
const { data, provenance } = await partialCoerceWithProvenance<Listing>(listingHtml, {
  provider,
  schema: listingSchema,
});

// data       → { name: "Sea Cabin", sleeps: 6 }
// provenance → {
//   name:   { confidence: "high",   evidence: "the Sea Cabin sleeps 6" },
//   sleeps: { confidence: "medium", evidence: "sleeps 6" },
// }
```

With several sources, each entry also carries `source`, the label of the one
the value was read from.

Confidence is a three-level scale rather than a number: models are poorly
calibrated at producing a 0–1 score, and a review UI only needs to decide
whether to flag a field anyway. `evidence` is absent when the value was
inferred rather than read — which is itself the signal worth showing.

Under the hood this asks for a derived schema where each field is wrapped as
`{ value, confidence, evidence }`, then splits the response back apart and
validates the values against your original schema. No provider knows anything
about it. Only top-level fields are annotated; a nested object keeps its
ordinary shape inside `value`.

It costs a larger schema and a longer response, so reach for it where a human
reviews the result rather than on a hot path. It isn't available on the fluent
chain — an intermediate link's annotations would be serialized into the next
call and lost.

## Providers

`Provider` is a one-method interface — `complete(request) => Promise<response>`
— and lives in `@sembl/core`. Provider packages are separate so an app installs
only the SDK it uses:

| Package                     | Mechanism                                             |
| --------------------------- | ----------------------------------------------------- |
| `@sembl/provider-anthropic` | forced tool call (`tool_choice: { type: "tool" }`)    |
| `@sembl/provider-openai`    | structured outputs (`response_format: json_schema`)   |

Both wrap their SDK's own retry and timeout handling rather than re-implementing
it, and raise a typed error carrying a `kind` — `api`, `truncated`, or
`no_output` — so a caller can tell a rate limit from a refusal from an output
that ran out of tokens. The Anthropic provider can cache the stable prefix
(system prompt plus tool schema) across a batch, which is where the cost goes
when you are importing many records against one schema.

Each provider owns its own JSON Schema dialect. Core emits either from a
`RuntimeSchema`: `"openai-strict"` (every property in `required`, optional
fields as `anyOf: [T, null]`) or `"standard"` (only required fields in
`required`). Nested schemas are inlined in both — no `$ref`.

Anything with a `complete` method works, so wrapping a gateway, a local model,
or a fake for tests takes a few lines:

```ts
const fakeProvider: Provider = {
  async complete() {
    return { data: { city: "Berlin" } };
  },
};
```

The Anthropic provider also accepts a pre-built client, for apps that resolve
credentials through Secret Manager, Vault, Bedrock, or Vertex rather than an
env var — see [its README](packages/provider-anthropic/README.md).

## Tracing

Pass `traceSinks` to see what the pipeline actually did — prompt construction,
schema build, the LLM call with token usage, validation — as nested spans:

```ts
SemblConfig.configure({ provider, bundle, traceSinks: [new ConsoleSink()] });
```

Implement `TraceSink` (a single `write(span)`) to forward spans to OpenTelemetry
or your own logger.

## Packages

| Package                     | What it is                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `@sembl/core`               | decorators, runtime schema, coerce API, validation, tracing         |
| `@sembl/compiler`           | AST extractor and the `sembl extract` CLI                           |
| `@sembl/provider-anthropic` | Anthropic provider                                                  |
| `@sembl/provider-openai`    | OpenAI provider                                                     |
| `@sembl/source-html`        | HTML → readable text, JSON-LD and meta first                        |
| `@sembl/examples`           | runnable demo (private)                                             |

## Development

```sh
pnpm install
pnpm build   # schema extraction runs as part of the examples package's build
pnpm test
pnpm lint    # typechecks each package against its dependencies' built types
pnpm check:exports  # packs each package and checks its exports map with arethetypeswrong
```

`pnpm lint` has to follow `pnpm build`: packages are typechecked against the
`.d.ts` their dependencies emit, so those have to exist first. CI runs exactly
these steps.

To run the demo against a live model, build, then:

```sh
OPENAI_API_KEY=... pnpm --filter @sembl/examples demo
```

## Releasing

Packages version in lockstep and publish from CI on a tag:

```sh
pnpm version:set 0.2.0
git commit -am "Release 0.2.0" && git tag v0.2.0
git push && git push --tags
```

The tag triggers a workflow that builds, tests, typechecks, verifies the tag
matches every package version, and publishes with provenance.

Publish with **pnpm**, never `npm publish` — pnpm rewrites `workspace:*`
dependencies to real versions on the way out, and npm does not, so an `npm
publish` here would ship manifests nobody can install.

## Status

Early. The shape of the API is settling but nothing is 1.0. Known gaps, roughly
in the order they bite:

- **The compiler reads classes only.** Plain `interface`s and `type`s are
  invisible to it; describe those with `defineSchema` instead.
- **Constraints reach OpenAI through the prompt, not the schema.** Strict mode
  rejects a request outright if it carries a keyword it doesn't accept, and we
  couldn't establish which of `maxLength`/`minimum`/`pattern`/… it currently
  takes, so they're omitted there and enforced by the prompt and the validator
  instead. Anthropic gets them in the schema. See `CONSTRAINT_KEYWORDS` in
  `@sembl/core` for the one place to change if you verify otherwise.
- **No index-signature types.** A `Record<string, string>` has no `FieldType`
  equivalent; the compiler warns rather than mistyping it.
- **Provenance is top-level only.** A nested object is annotated as a whole,
  not per leaf.
- **Repair is single-turn.** The correction travels as user text rather than a
  real assistant turn, because the `Provider` interface is single-turn.
