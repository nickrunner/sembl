# @sembl/source-feed

Turn the feeds that are not HTML — XML, RSS and Atom, iCalendar, JSON from
an API — into text SEMBL can extract from, and split the multi-item ones
into one source per item for `coerceMany`. No third-party dependencies:
Node's own APIs plus a small XML tokenizer and an iCalendar parser of its
own. The only other package it uses is `@sembl/source-html`, for the HTML
that feeds carry inside CDATA and content blocks.

```sh
pnpm add @sembl/source-feed
```

```ts
import { coerceMany } from "@sembl/core";
import { xmlItems } from "@sembl/source-feed";

const xml = await (await fetch(feedUrl)).text();
const results = await coerceMany<Listing>(xmlItems(xml, "listings/listing", "Listing"), {
  provider,
  schema,
  mode: "partialCoerce",
});
```

Every renderer here produces the same kind of text: a compact,
self-describing outline the model reads well — `key: value` lines,
children indented, no braces, quotes, tags or commas. Long strings stay
whole. Nothing is fetched; fetching is yours.

## JSON

`jsonSource(value, label?, options?)` renders a value an API returned (not
the raw body — pass what `JSON.parse` gave you) as an outline: arrays as
numbered items, nulls written out, empty containers noted as `(empty list)`
or `(empty object)`, multi-line strings indented under their key.

```
data:
  listings:
    1.
      title: Sea Cabin & Sauna
      price:
        amount: 250
        currency: EUR
      amenities:
        1. wifi
        2. sauna
      photos: (empty list)
      rating: null
```

Options: `maxDepth` (levels of nesting to expand; deeper containers become
one line of compact JSON), `maxArrayItems` (a line says how many were left
out), `omitKeys` (dropped wherever they occur — tracking ids, hashes), and
`redact(path, value)`, called for every property and element with a path
like `data.listings[0].host.email`; return a replacement or `undefined` to
drop it. Cycles render as `(circular)`.

`jsonItems(value, "data.listings", "Listing")` returns one source per
element of the array at that dot/bracket path, labelled `Listing 1`,
`Listing 2`, … `getPath` is exported for the same path syntax.

## XML

`xmlSource(xml, label?, options?)` renders an element tree as the same
outline: `name: text` for leaves, `name:` with children beneath for the
rest, attributes as `@name: value`. Namespace prefixes and `xmlns`
declarations are stripped (`namespaces: true` keeps them), CDATA and
entities are decoded, and text that contains markup — a description held as
HTML — is converted to plain text with `@sembl/source-html` (`html: false`
leaves it). Repeated elements repeat, which is how a model best sees that a
listing has three photos.

```
listing:
  @id: sc-101
  title: Sea Cabin & Sauna
  price: 250
    @currency: EUR
  amenity: wifi
  amenity: sauna
```

`xmlItems(xml, "listings/listing", "Listing")` returns one source per
matched element. The selector is a simple slash path from the root — `*`
for any name, a leading `//` for a name at any depth — not XPath: a feed
has one shape and the path says it. It throws when nothing matches, since a
batch of nothing is almost always a wrong path. `parseXml`,
`selectElements`, `childElement`, `childElements`, `textOf` and
`elementToText` are exported for anything else.

The tokenizer is linear and strict about structure: a mismatched or
unclosed tag, an unquoted attribute or a second root is a `FeedError` with
the line number. A DOCTYPE is skipped whole; no entity it declares is
expanded and nothing is fetched.

## RSS and Atom

`feedItems(xml, label?)` detects RSS 2.0, RSS 1.0 (RDF) and Atom from the
root element and returns one source per entry:

```
Title: Sea Cabin reopens for spring
Link: https://coastal-stays.example/news/sea-cabin-spring
Published: Mon, 02 Mar 2026 09:00:00 GMT
Author: Ann Berg
Categories: openings, cabins

The Sea Cabin is back from 15 March.
```

The content is `content:encoded` or `description` for RSS, `content` or
`summary` for Atom, converted from HTML with `htmlToText`. `parseFeed`
returns the same as data (`FeedEntry[]` with the feed's own title and link)
and `feedSource` renders a whole feed as one source.

## iCalendar

`icsSource(ics, label?, options?)` renders a VCALENDAR as readable event
blocks. Folded lines are unfolded and escaped text undone; DTSTART and
DTEND are shown as written, with the zone, and an all-day DTEND is
explained as exclusive; a DURATION is shown with its length; an RRULE is
kept verbatim with a plain-English gloss for the daily, weekly, monthly
and yearly forms (INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT, UNTIL); EXDATE
and RDATE are listed; transparent events say so.

```
Event: Cleaning block
  Starts: 2026-03-02 10:00 (Europe/Oslo)
  Ends: 2026-03-02 13:00 (Europe/Oslo)
  Length: 3 hours
  Repeats: every week on Monday until 2026-04-27 08:00 UTC (RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260427T080000Z)
  Except: 2026-03-16 10:00 (Europe/Oslo)
  Location: Sea Cabin, Bergen
```

`icsEvents(ics, label?)` returns one source per VEVENT. UIDs are left out
unless `uid: true`; `description: false` drops descriptions.

### Availability without a model

Which nights are taken is arithmetic, not extraction, so it is done as
data:

```ts
import { availabilityWindows } from "@sembl/source-feed";

const busy = availabilityWindows(ics, { from: "2026-03-01", to: "2026-05-01", merge: true });
// [{ start: Date, end: Date, allDay: true, summary: "Booked, Smith family" }, …]
```

Every occurrence of every event that overlaps the window is returned,
sorted by start, with `end` exclusive: recurrence rules expanded (daily,
weekly, monthly, yearly; INTERVAL, COUNT, UNTIL, BYDAY with ordinals,
BYMONTHDAY, BYMONTH, WKST), EXDATE and RDATE applied, RECURRENCE-ID
overrides honoured, TZIDs converted through the platform's zone data so a
weekly 10:00 block stays at 10:00 across a DST change, and `TRANSP:
TRANSPARENT` and `STATUS:CANCELLED` events left out (options include them).
All-day ranges run from UTC midnight to UTC midnight. A TZID Node does not
know — a Windows zone name from an Outlook export — falls back to the fixed
offset of the file's VTIMEZONE, or to floating time. Expansion stops at
the window's end and is capped, so an unbounded rule costs a loop, never a
hang. Rules using BYSETPOS, BYWEEKNO, BYYEARDAY or sub-daily frequencies
are not expanded beyond their first occurrence.

## Errors and limits

Every parser throws `FeedError` — with `format` (`json`, `xml`, `feed`,
`ics`) and, where the parser knows it, `line` — for input it cannot make
sense of. Input over `maxInputChars` (default 8,000,000) is refused before
parsing; the parsers are linear, so the guard bounds work rather than
patching a hot spot.
