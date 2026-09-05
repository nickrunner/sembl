# @sembl/source-image-sharp

An `ImageResizer` for `@sembl/source-image`, on [sharp](https://sharp.pixelplumbing.com/)
(libvips). Downscale to the long edge a model actually reads, rotate
upright, strip the metadata, convert to JPEG or WebP, and decode HEIC where
the installed libvips can.

```sh
pnpm add @sembl/source-image @sembl/source-image-sharp
```

```ts
import { imageSources, prepareImages } from "@sembl/source-image";
import { SharpResizer } from "@sembl/source-image-sharp";

const sources = await imageSources("IMG_4021.jpg", "Listing photo");
const prepared = await prepareImages(sources, new SharpResizer());
await coerce<Listing>(prepared, { provider, schema });
```

`prepareImages` reads each image's EXIF before the resizer strips it, so
the metadata source — capture time, GPS position, camera — still comes
from the original. Nothing in `@sembl/source-image` changes when this
package is absent; it is the one that carries the native dependency.

## What it does

`new SharpResizer(defaults?)` takes the same options as `resize`, as
defaults for every call:

- `maxEdge` — scale so the longer edge is at most this many pixels, never
  enlarging. Default 1568.
- `format` — `"image/jpeg"`, `"image/png"` or `"image/webp"`. By default
  PNG stays PNG (screenshots and renders lose nothing), WebP stays WebP,
  and everything else — JPEG, HEIC, TIFF, GIF, AVIF, BMP — becomes JPEG.
- `quality` — for JPEG and WebP. Default 85.
- `autoOrient` — rotate the pixels by the EXIF orientation so the output is
  upright with orientation 1. Default true. A model reads an upright sign
  better than one on its side.
- `stripMetadata` — drop EXIF, XMP, ICC and the rest. Default true.
- `limitInputPixels` — refuse to decode anything with more pixels than
  this; sharp's own default is 268 megapixels. Worth lowering for images
  scraped from pages you do not control.

The result is `{ data, mediaType, width, height }`, with the size after
rotation and scaling.

## Why 1568

Anthropic recommends a long edge of 1568 pixels, and downscales anything
larger on its side before the model sees it. Tokens are roughly
`width × height / 750`: at 1568 a 4:3 photo is about 1.15 megapixels,
around 1 600 tokens. A 12-megapixel phone photo sent as is costs no more
in tokens — the API scales it first — but takes ten times the bytes to
upload, can exceed Anthropic's 5 MB per-image cap, and in OpenAI's
high-detail mode is tiled into more 512-pixel squares at 170 tokens each.
Below 1568 the model starts to lose small text on signs and forms. So:
1568 on the long edge, never enlarged. Pass a smaller `maxEdge` for a
gallery where each picture matters less than the count.

## HEIC

An iPhone's default format is HEIC, which neither provider accepts.
`SharpResizer` converts it to JPEG when the installed sharp can decode it,
and that is the catch: the prebuilt binaries sharp installs from npm ship
libvips with libheif but without an HEVC decoder (only the AV1 codecs, for
AVIF), so a HEIC from a phone does not decode. `sharpSupportsHeif()` says
whether the build has HEIF at all; a HEIC that does not decode is thrown as
an `ImageSourceError` of kind `"unsupported"` whose message names the
cause. To decode HEIC, install sharp against a system libvips built with
libheif and libde265 or x265 — see sharp's installation notes — or convert
before the bytes get here (`sips -s format jpeg` on macOS, `heif-convert`
on Linux).

## Licences

sharp is Apache-2.0 and bundles a prebuilt libvips (LGPL-3.0-or-later)
with its codecs; see sharp's own licence notes for the list. This package
is MIT.
