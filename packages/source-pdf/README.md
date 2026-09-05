# @sembl/source-pdf

Turn a PDF into text SEMBL can extract from. Node only; works with any
provider, since what reaches the model is plain text.

```sh
pnpm add @sembl/source-pdf
```

```ts
import { coerce } from "@sembl/core";
import { pdfSource, readPdfFile } from "@sembl/source-pdf";

const pdf = await readPdfFile("brochure.pdf");
const listing = await coerce<Listing>(await pdfSource(pdf, "Brochure"), {
  provider,
  schema,
  maxInputChars: 40_000,
});
```

`pdfSource(data, label)` renders the document in two sections:

1. **Document metadata** — the title, author, subject, keywords, creation
   and modification dates, and page count, from the info dictionary with XMP
   as a fallback. Only what the document actually has.
2. **Document text** — every page's lines rebuilt from the glyph positions,
   with each page introduced by `--- Page N ---`.

Metadata goes first on purpose: SEMBL's default truncation keeps the head of
a source, so a document that blows the input budget loses its last pages,
never its title.

`pdfSources(data, label)` returns the same content as several sources: the
metadata on its own, then one source per page labelled `"Brochure (page 3)"`.
SEMBL's budget cuts long sources first, so a 40-page brochure loses the
tail of its longest pages instead of every page after the first few, and
provenance names the page each value was read from. Use it for anything
longer than a couple of pages; `pdfSource` is simpler when the document is
short and you want one label.

Pages with no text layer are left out of both. A scanned document therefore
comes back as an empty string, so check first when that matters:

```ts
import { pdfInfo } from "@sembl/source-pdf";

const info = await pdfInfo(pdf);
if (!info.hasText) {
  // A scan: hand the pages to an image path instead.
}
```

`pdfInfo` returns `{ pageCount, hasText, pagesWithText, encrypted, metadata }`.

## Options

Every reader takes `pages` (1-based; a list `[1, 3]` or a range
`{ from: 2, to: 5 }` with either end open), `maxPages` (a cap on the
selected pages, from the first), `password` (for an encrypted document) and
`timeoutMs` (default 30 000). The source builders also take `meta: false` to
leave the metadata out.

```ts
await pdfToText(pdf, { pages: { from: 2 }, maxPages: 10 });
await pdfSources(pdf, "Contract", { password: "hunter2" });
```

## The pieces

- `pdfToText(data, options)` — the text with page breaks marked.
- `pdfPages(data, options)` — `[{ number, text }]` per selected page, empty
  pages included.
- `extractPdfMetadata(data)` — the metadata as an object, dates as `Date`s;
  `formatPdfMetadata` renders it the way `pdfSource` does.
- `pdfInfo(data)` — page count, whether there is text, and the metadata.
- `readPdfFile(path)` — a file from disk as bytes. Every reader also takes
  an `ArrayBuffer` or any `Uint8Array`, a `Buffer` included, and never
  modifies it.
- `itemsToText`, `itemsToRuns`, `runsToText` — the layout pass on its own,
  for pdf.js text items you already have.

## Errors

Every failure is a `PdfError` with a `code` to branch on:
`password-required`, `wrong-password`, `invalid` (not a PDF, or too damaged
to open), `timeout`, or `unknown`. Malformed input fails fast rather than
hanging; the parser is Mozilla's pdf.js, which is fuzzed and stops at the
first unrecoverable structure.

## How the text is rebuilt

A PDF places runs of glyphs at coordinates in whatever order the producer
liked, with no lines or paragraphs. This package groups runs by baseline,
orders each line left to right, and spaces runs by the gap between them: a
small gap is a space, a wide one — a table column — is two spaces, so a row
of cells stays on one line with its cells visibly apart. A tall gap between
lines becomes a blank line. Multi-column text reads across the columns
rather than down them, with the gutter kept as spaces; rotated text is
grouped as if horizontal. There is no OCR: a scan yields nothing.

The parser is [`pdfjs-dist`](https://github.com/mozilla/pdf.js)
(Apache-2.0), used through its Node build with no DOM, canvas or worker
thread, and loaded on first use. It needs Node 22.13 or later. It makes no
network requests.
