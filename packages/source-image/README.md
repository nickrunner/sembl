# @sembl/source-image

Everything around an image that SEMBL's core does not do: read what the
file says about itself, download a page's gallery, and resize through a
pluggable resizer. Zero dependencies.

```sh
pnpm add @sembl/source-image
```

Core already sends images to the model: an `ImageSource` is bytes plus a
media type, and both bundled providers take one natively. This package
supplies the rest.

```ts
import { partialCoerceWithProvenance } from "@sembl/core";
import { imageSources } from "@sembl/source-image";

const sources = await imageSources("photos/IMG_4021.jpg", "Listing photo");
// → [ { label: "Listing photo", image: { data, mediaType: "image/jpeg" } },
//     { label: "Listing photo (photo metadata)", text: "Facts recorded in the image file's headers…" } ]

const { data, provenance } = await partialCoerceWithProvenance<Listing>(sources, { provider, schema });
provenance.address?.source; // → "Listing photo (photo metadata)"
```

## Why the metadata source

A model reading a photograph can only guess at when and where it was
taken. The file knows: a phone writes the capture time and the GPS position
of the camera into the JPEG's EXIF, and they travel with the picture until
something strips them. `imageSources` reads those headers and renders them
as a short text source beside the image:

```
Facts recorded in the image file's headers (EXIF), not read from the picture:
Taken: 2025-06-14 09:12:30 (camera clock, UTC-07:00)
GPS position of the camera: 44.311400, -124.104900 (latitude, longitude, decimal degrees WGS84); altitude 12 m above sea level
Orientation: 6 (rotated 90° clockwise to display (stored on its side))
Camera: Apple iPhone 15 Pro
Software: 17.5.1
Dimensions: 4032×3024 pixels (JPEG)
```

For an address, the GPS line is better evidence than anything read off the
picture. A street sign in the frame may be the neighbour's, a house number
may be misread, a storefront may be a chain with a hundred branches; the
coordinates are where the camera physically stood, to a few metres, as a
measurement rather than an inference. Putting them in a separate, labelled
text source means the model gets them as facts instead of squinting for
them, provenance can cite the metadata source, and a review UI can show the
coordinates that backed the address. The first line says the facts came
from the file and not the picture, so the model does not treat a position
as something it saw.

Only the lines that exist are rendered. A screenshot has no camera, a PNG
rarely has EXIF, a photo shared through a messaging app has had its GPS
stripped — and the source then says so in one line, which is itself
useful: the model knows there is no position to infer from.

EXIF stores the capture time as a wall clock with no zone. When the file
carries an `OffsetTime*` tag the instant is exact; otherwise `takenAt` reads
the digits as UTC and `takenAtLocal` holds them as written.

## Reading headers

Everything here reads headers only. Nothing is decoded, so each call is
microseconds and safe on hostile input.

- `sniffImageType(bytes)` — `"image/jpeg" | "image/png" | "image/gif" | "image/webp"`
  from the magic bytes, or `undefined`. `detectImageType` also names HEIC,
  HEIF, AVIF, TIFF and BMP so a refusal can say what the file was.
- `imageDimensions(bytes)` — `{ width, height }` from a JPEG's SOF, a PNG's
  IHDR, a GIF's screen descriptor, or any WebP flavour (VP8, VP8L, VP8X).
  The stored size: a photo with orientation 6 reports the sensor's width
  and height, not the displayed ones.
- `extractExif(bytes)` — an `ImageMetadata`: the format and size, then
  `takenAt`, `gps` as decimal degrees with the hemisphere applied,
  `orientation`, `make`, `model`, `software`, `description`, `userComment`.
  JPEG APP1, WebP `EXIF` chunks and PNG `eXIf` chunks, in either byte
  order. Never throws: a malformed block yields what was readable before
  the damage.
- `renderImageMetadata(metadata)` — the text above.

`writeExif(jpeg, metadata)` is the small inverse — capture time, GPS,
orientation, camera, a caption — for building fixtures and tests. It is
not an EXIF editor.

## Building sources

`imageSource(input, label?, options?)` takes bytes, an `ArrayBuffer`, a
file path, or `{ url }`, sniffs the format, and returns an `ImageSource`.
A format the providers do not accept is refused with an `ImageSourceError`
of kind `"unsupported"` that names it ("HEIC images are not accepted…") and
points at the fix; anything over `maxBytes` is `"too_large"`; a path that
will not read is `"unreadable"`. A URL is passed through for the provider
to fetch — use `fetchImages` to download it here and get the same checks.

`maxBytes` defaults to 20 MB, the most either provider accepts per image.
Anthropic's own cap is 5 MB, so a photo straight off a phone can pass this
check and still be refused there; the answer is a resizer, below, which
also brings the pixel count down to what the model reads anyway.

`imageSources(input, label?, { metadata })` returns the image and its
metadata source, as above. `metadata: false` leaves the second out.

## Downloading a gallery

`fetchImages` pairs with `@sembl/source-html`'s `extractImages`: the one
finds the images a page shows, the other downloads them.

```ts
import { extractImages } from "@sembl/source-html";
import { fetchImages } from "@sembl/source-image";

const images = extractImages(html, { baseUrl: url });
const { sources, skipped } = await fetchImages(images, { max: 6 });
await coerce<Listing>([...htmlSources(html, "Listing page"), ...sources], { provider, schema, maxImages: 6 });
```

Each download is checked and nothing is thrown for one bad URL: a non-2xx
status, a `Content-Type` that is not an image (an `application/octet-stream`
is let through to the sniff), a `Content-Length` over `maxBytes`, a body
that grows past `maxBytes` while it streams, a timeout, and bytes that are
not an accepted image all land in `skipped` with a `reason` to branch on.
The magic bytes decide the media type sent to the provider, not the header.
Only the first `max` URLs are fetched (default 10), `concurrency` bounds
what is in flight (default 4), `timeoutMs` bounds each (default 15 s),
`headers` go on every request, and `label` names each source — by default
the page's alt text, else `Image N`. `fetch` is injectable, so a test can
serve files from disk.

## Resizing

Reading headers needs no decoder; scaling pixels does, and decoders are
native code. So resizing sits behind an interface, and this package stays
dependency-free:

```ts
interface ImageResizer {
  resize(
    image: { data: Uint8Array; mediaType: string },
    options?: { maxEdge?: number; format?: "image/jpeg" | "image/png" | "image/webp"; quality?: number; stripMetadata?: boolean; autoOrient?: boolean },
  ): Promise<{ data: Uint8Array; mediaType: ImageMediaType; width: number; height: number }>;
}
```

`@sembl/source-image-sharp` implements it on sharp. `NoopResizer` passes
bytes through, for tests and for pipelines that want the metadata handling
without a native dependency.

`prepareImages(sources, resizer, options)` runs every inline image source
through a resizer and leaves text, document and URL sources alone. Each
image's EXIF is read *before* the resizer sees it, so the metadata source
is built from the original — a stripped, re-encoded JPEG has no GPS left
to read. A metadata source that `imageSources` already added is kept, not
duplicated; `onError: "skip"` drops an image the resizer cannot handle
instead of failing the call.

```ts
import { SharpResizer } from "@sembl/source-image-sharp";

const prepared = await prepareImages(sources, new SharpResizer(), { maxEdge: 1568 });
```

## Errors

Everything throws `ImageSourceError`, with `kind` one of `"unsupported"`,
`"too_large"`, `"unreadable"` or `"fetch"`. Branch on the kind; messages
are diagnostic and free to change.

This package reads files from disk when given a path and otherwise touches
nothing outside the bytes it is handed. It makes no network requests except
in `fetchImages`, and there only through the `fetch` it was given or the
global one.
