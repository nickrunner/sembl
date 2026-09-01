# @sembl/core

Runtime for SEMBL — semantic coercion for TypeScript. Describe what a type
*means*, and turn unstructured input into a validated instance of it.

```ts
const draft = await sembl(listingHtml).partialCoerceTo(StayDetailsSchema);
```

This package holds the decorators, the runtime schema types, the coerce API,
validation, and tracing. Schemas are produced from your decorated classes by
[`@sembl/compiler`](https://github.com/nickrunner/sembl/tree/main/packages/compiler);
the LLM call is made by a provider package
([Anthropic](https://github.com/nickrunner/sembl/tree/main/packages/provider-anthropic),
[OpenAI](https://github.com/nickrunner/sembl/tree/main/packages/provider-openai)).

See the [project README](https://github.com/nickrunner/sembl#readme) for the
full walkthrough.

## Install

```sh
pnpm add @sembl/core
pnpm add -D @sembl/compiler
```

## Describing a type

`@Schema` says what a type is for, `@Describe` what each field means,
`@Constrain` bounds a value beyond its type, and `@ValuesFrom` says the legal
values come from somewhere resolved at runtime.

```ts
import { Schema, Describe, Constrain, ValuesFrom } from "@sembl/core";

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

## Coercing

`coerce` throws if a required field is missing; `partialCoerce` doesn't, and
returns `Partial<T>` with nulls stripped — the right one for pre-filling a form
a human will review. Both throw `CoerceError` on a type mismatch or a violated
constraint, with a `FieldValidationIssue[]` a form can render per field.

```ts
import { sembl, SemblConfig } from "@sembl/core";

SemblConfig.configure({
  provider,
  bundle,
  // Called once per distinct source per coercion; you own any caching.
  enumResolver: async (sourceId) => (await cms.taxonomy(sourceId)).map((d) => d.slug),
});

const draft = await sembl(listingHtml).partialCoerceTo<Listing>(listingSchema);
```

If a source backing a **required** field fails to resolve, coercion throws
`EnumResolutionError` rather than quietly widening the field to a free-form
string. A source backing only optional fields widens and records a trace event.

## Tracing

Pass `traceSinks` to see prompt construction, schema build, enum resolution,
the LLM call with token usage, and validation as nested spans. Implement
`TraceSink` (one `write(span)` method) to forward them anywhere.
