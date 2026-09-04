# @sembl/source-html

Turn an HTML page into text SEMBL can extract from. Zero dependencies.

```sh
pnpm add @sembl/source-html
```

```ts
import { coerce } from "@sembl/core";
import { htmlSource } from "@sembl/source-html";

const html = await (await fetch(url)).text();
const listing = await coerce<Listing>(htmlSource(html, "Airbnb listing"), {
  provider,
  schema,
  maxInputChars: 40_000,
});
```

`htmlSource` renders the page in three sections, in this order:

1. **Page metadata** — the `<title>` and every `<meta>` tag keyed by
   `property` or `name` (OpenGraph, Twitter cards, `description`, …).
2. **Structured data** — each `<script type="application/ld+json">` block that
   parses, as compact JSON.
3. **Page text** — the body with scripts, styles, comments and the head
   removed, block elements as line breaks, list items bulleted, entities
   decoded and whitespace collapsed.

Structured data goes first on purpose: SEMBL's default truncation keeps the
head of a source, so when a page blows the input budget the cleanest facts on
it are the ones that survive.

The pieces are exported on their own — `pageToText`, `htmlToText`,
`extractJsonLd`, `extractMeta`, `decodeEntities` — and `preprocessHtml()`
returns a `preprocess` hook for when the sources are pages but you would
rather keep fetching and coercion apart:

```ts
await coerce(pages, { provider, schema, preprocess: preprocessHtml() });
```

The conversion is regex-based rather than a full parser, so malformed markup
degrades to slightly worse text instead of an error — the right trade for
scraped input. It makes no network requests; fetching is yours.
