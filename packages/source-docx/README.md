# @sembl/source-docx

Turn a Word document into text SEMBL can extract from, with its structure
kept. Reads `.docx` and `.odt`. Zero dependencies; Node only.

```sh
pnpm add @sembl/source-docx
```

```ts
import { coerce } from "@sembl/core";
import { docxSources, readDocxFile } from "@sembl/source-docx";

const data = await readDocxFile("handover-notes.docx");
const listing = await coerce<Listing>(await docxSources(data, "Handover notes"), {
  provider,
  schema,
  maxInputChars: 40_000,
});
```

`docxSources(data, label)` returns one labelled source per top-level
section — `"Handover notes — Access"`, `"Handover notes — Amenities"` — plus a
leading source for the metadata and anything before the first heading.
SEMBL's budget cuts long sources first, so a long document loses the tail of
its longest sections rather than everything past some point, and provenance
can say which section a value was read from. A document with no headings
comes back as a single source.

`docxToText(data)` renders the whole document as one string, in two sections:

1. **Document metadata** — the core properties the document carries: title,
   author, created and modified dates, and the word count the writing
   application recorded.
2. **Document text** — the body, with headings as Markdown `#` lines, list
   items as `- ` (or `1. `) lines indented by nesting, tables as
   pipe-delimited rows with a separator under the header row, embedded
   images as `[image: name]`, and footnotes marked `[^n]` in the text and
   listed at the end. Bold, italic and every other formatting choice is
   dropped. Tracked changes are resolved to the final text: insertions kept,
   deletions gone. Page headers and footers are left out unless asked for.

Metadata goes first for the same reason it does in `@sembl/source-html`:
SEMBL's default truncation keeps the head of a source, so the cleanest
facts survive when a document blows the input budget.

The options are the same on every function:

```ts
await docxToText(data, {
  headersFooters: true, // include page headers and footers (default false)
  footnotes: false,     // drop footnote markers and the notes (default true)
  tables: "lines",      // one cell per line instead of pipe rows (default "pipes")
  metadata: false,      // leave the core properties out (default true)
});
```

`docxSource(data, label)` builds a single labelled source;
`extractDocxMetadata(data)` returns just the core properties as an object;
`readDocxFile(path)` reads the bytes so the other functions, which all take
a `Uint8Array` or `ArrayBuffer`, can be fed from disk, a fetch or an upload
alike.

Anything that is not a readable document throws a `DocxError` whose `code`
says why: `not-a-document` for bytes that are not a zip, `encrypted` for a
password-protected file (or a legacy binary `.doc`, which shares its
container), `unsupported` for RTF, spreadsheets and the like, and
`malformed` for a package with broken or missing parts.

The package reads the OOXML and ODF packages directly — a small zip reader
over Node's `zlib` and a namespace-aware XML pass — rather than converting
through HTML, so table header rows, merged cells, nested lists and note
references come from the document's own markup. It does no rendering and
never leaves the process: fetching and uploading are yours.
