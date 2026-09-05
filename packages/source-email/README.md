# @sembl/source-email

Turn an email into sources SEMBL can extract from: a raw `.eml`, a message
you already hold parsed, or a whole thread. Node only.

```sh
pnpm add @sembl/source-email
```

```ts
import { coerce } from "@sembl/core";
import { emailSource } from "@sembl/source-email";

const eml = await readFile("inquiry.eml");
const listing = await coerce<Listing>(await emailSource(eml), { provider, schema });
```

`emailSource(input, options?)` returns one labelled source: a header block —
`From`, `To`, `Cc`, `Date`, `Subject`, `Message-ID`, `In-Reply-To`, then one
line per attachment — a blank line, and the message's own content. The
plain-text part is preferred; an HTML-only message is converted with
`@sembl/source-html`'s `htmlToText`, with tracking pixels, hidden preheaders
and link targets gone. The label defaults to the subject.

Headers go first on purpose: SEMBL's default truncation keeps the head of a
source, so on a message that blows the budget, who sent it and when survive.

By default the source carries only what the message's author wrote:

- **Quoted replies are stripped.** `>`-quoted lines go wherever they are,
  so an interleaved reply keeps every answer; the "On … wrote:" line above
  a quote goes with it; an Outlook-style `-----Original Message-----` or
  `From:/Sent:/To:/Subject:` block ends the message. A forward is the
  exception — after "---------- Forwarded message ---------", "Begin
  forwarded message:" or the first reply marker of a message whose subject
  says `Fwd:`, the content is kept, since it is usually the point. A
  `message/rfc822` attachment is rendered into the body the same way.
- **Signatures are stripped**, conservatively: everything after an RFC 3676
  `-- ` line, a "Sent from my iPhone" line, and a final short block made of
  contact lines — a bare phone number, URL or address. A sentence that
  happens to mention a phone number is kept.

`stripQuotedReplies: false` and `stripSignatures: false` turn either off;
`includeHeaders: ["Subject", "Reply-To"]` chooses the header block; `label`
names the source. Non-UTF-8 charsets and RFC 2047 encoded headers are
decoded; `multipart/alternative` yields the text part; inline images are
listed, never inlined. Input that is not a message at all — no `From`,
`Subject`, `Date`, `Message-ID` or `Content-Type` to be found — throws an
`EmailParseError` rather than producing an empty source.

## Attachments

`emailSources(input, options?)` returns the message plus one source per
text-like attachment — `.txt`, `.md`, `.csv` as they are, `.html` through
`@sembl/source-html` — and hands back everything else with its bytes, so a
PDF or an image can go to a package that reads that kind and join the same
coercion:

```ts
import { emailSources } from "@sembl/source-email";

const { sources, attachments } = await emailSources(eml);
for (const { label, attachment } of attachments) {
  if (attachment.mediaType === "application/pdf") {
    sources.push(await pdfSource(attachment.data, label));   // your PDF package
  }
}
const listing = await coerce<Listing>(sources, { provider, schema });
```

Each routed attachment is `{ label, attachment: { filename, mediaType, data,
inline?, contentId? } }`; the label extends the message's own, so provenance
can say which file a value came from. Every attachment is also listed in the
message source as `Attachment: floor-plan.pdf (application/pdf, 24 KB)`, so
the model knows the file exists even when nothing reads it. Inline images
come back flagged `inline` — a photo pasted into the message is not lost,
and a signature logo is easy to skip on the flag or on size.

## Threads

`threadSources(messages, options?)` takes an array of messages — raw or
parsed — or a single mbox string, and returns them as ordered sources,
oldest first, labelled `Message 2 from Alice Nguyen on 2025-09-01`. Quoted
history is stripped from every message, so each contributes only what its
author wrote and the model reads the conversation once rather than N times
over. Text-like attachments follow the message they came with; the rest are
returned for routing as above.

```ts
const { sources } = await threadSources(await readFile("handover.mbox", "utf8"));
const listing = await partialCoerce<Listing>(sources, { provider, schema });
```

`order: "given"` keeps the order you passed instead of sorting by `Date`.

## The pieces

`parseEmail(input)` returns the structured message — `headers` (lowercase
names), `from`, `to`, `cc`, `subject`, `date` (ISO 8601), `messageId`,
`inReplyTo`, `text`, `html`, `attachments` — for callers who want the parts
rather than a source. Its output is accepted anywhere an input is, as is
any `{ headers, text?, html?, attachments? }` object from a mail API.
`emailToText`, `stripQuotedReplies`, `stripSignature`, `emailHtmlToText`
and `splitMbox` are exported on their own.

Parsing is done by [`postal-mime`](https://github.com/postalsys/postal-mime)
(MIT-0, no dependencies), which is lenient by design: odd MIME degrades to
a worse message rather than an error. The reply and signature rules are
patterns, not a parser, tuned to lose a stray "Sent from my iPhone" rather
than a line of data; where a message quotes something on purpose, turn
`stripQuotedReplies` off. Text attachments are decoded as UTF-8 with a
Windows-1252 fallback, since MIME does not reliably say. No network
requests are made; fetching is yours.
