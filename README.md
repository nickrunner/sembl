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

Swap in `@sembl/provider-openai` (plus `openai`) if that's your provider.

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
`@Schema` classes — nested or in arrays.

### 2. Compile them

```sh
npx sembl extract --input src/schemas --output src/generated
```

This walks the source AST — decorators are no-ops at runtime, so nothing is
reflected or evaluated — and emits one `<Name>.schema.ts` per class plus an
`index.ts` exporting a `SchemaBundle`. Generated output is build artifact:
check it into `.gitignore` and run `extract` before `build`.

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
| Returns               | `T`                                              | `Partial<T>`, with `null`s stripped                 |
| Use for               | a value the next step depends on                 | pre-filling a form the user will review             |

`CoerceError.issues` is a `FieldValidationIssue[]` — `path`, `message`,
`received` — so a form can surface per-field problems rather than one opaque
failure.

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

## Providers

`Provider` is a one-method interface — `complete(request) => Promise<response>`
— and lives in `@sembl/core`. Provider packages are separate so an app installs
only the SDK it uses:

| Package                     | Mechanism                                             |
| --------------------------- | ----------------------------------------------------- |
| `@sembl/provider-anthropic` | forced tool call (`tool_choice: { type: "tool" }`)    |
| `@sembl/provider-openai`    | structured outputs (`response_format: json_schema`)   |

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
| `@sembl/examples`           | runnable demo (private)                                             |

## Development

```sh
pnpm install
pnpm --filter @sembl/examples extract   # generated schemas are gitignored
pnpm build
pnpm test
pnpm lint                               # tsc --noEmit
```

The `extract` step must run before `build`: the examples package imports its
generated bundle, and a clean checkout doesn't have one yet.

To run the demo against a live model, build, then:

```sh
OPENAI_API_KEY=... pnpm --filter @sembl/examples demo
```

## Status

Early. The shape of the API is settling but nothing is 1.0. Known gaps, roughly
in the order they bite:

- **No constraint support.** `maxLength`, numeric ranges, and array-size caps
  aren't expressible on a field, so they can't reach the prompt or the JSON
  Schema, and validation won't catch them.
- **Enums are compile-time only.** A field whose legal values come from a
  database or CMS taxonomy at runtime has no way to declare them.
- **No repair loop.** A validation failure throws; it doesn't feed the issues
  back to the model for a second attempt.
- **No confidence or provenance.** Results don't say which fields were read
  straight out of the input and which were inferred.
- **Classes only.** The compiler reads decorated classes; plain `interface`s
  and `type`s are invisible to it.
