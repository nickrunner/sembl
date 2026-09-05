# @sembl/source-audio

Turn a recording into a timestamped text source SEMBL can extract from.

```sh
pnpm add @sembl/source-audio
```

```ts
import { readFile } from "node:fs/promises";
import { partialCoerceWithProvenance } from "@sembl/core";
import { audioSource, evidenceTimestamp, OpenAITranscriber } from "@sembl/source-audio";

const transcriber = new OpenAITranscriber({ apiKey });
const source = await audioSource(
  { data: await readFile("voice-note.m4a"), mediaType: "audio/mp4" },
  transcriber,
  { label: "Host voice note", segmentSeconds: 20 },
);

const { data, provenance } = await partialCoerceWithProvenance<Listing>(source, { provider, schema });
evidenceTimestamp(source.text, provenance.nightlyRate?.evidence);
// → { seconds: 22, timestamp: "00:00:22", line: "[00:00:22] I'm thinking two hundred and forty a night…" }
```

## The transcriber is pluggable

Neither of SEMBL's providers does structured output straight from audio, so
a recording has to become text first. This package puts that step behind one
interface and never looks at the bytes itself:

```ts
interface Transcriber {
  transcribe(
    audio: { data: Uint8Array; mediaType: string; filename?: string },
    options?: { language?: string; prompt?: string },
  ): Promise<Transcript>;
}

interface Transcript {
  text: string;
  language?: string;
  durationSec?: number;
  segments?: Array<{ start: number; end: number; text: string; speaker?: string }>;
}
```

`OpenAITranscriber` is the bundled one, over the `openai` SDK's
`audio.transcriptions` endpoint. A self-hosted Whisper, Deepgram, AssemblyAI,
or the transcript your phone system already produces fits the same
interface — return the segments and speakers you have, and everything
downstream (rendering, chunking, caching, provenance) works the same.
`FakeTranscriber` returns a transcript you wrote, for tests and demos.

Only `text` is required. Segments are what make the source citable by time;
without them the source is the prose and provenance quotes words rather than
moments.

## What the source looks like

```
Duration: 00:01:12
Language: en
Speakers: Host

[00:00:00] Host: Hi, it's Marta. Quick voice note about the lakehouse.
[00:00:13] Host: It sleeps eight — six in the bedrooms, and the sofa bed takes two more.
[00:00:22] Host: I'm thinking two hundred and forty a night, and that's in euros.
```

A short header with what is known about the recording — only the lines
that are, and `Language` as the transcriber reports it (whisper-1 says
`english`) — then one line per segment stamped with its start as
`HH:MM:SS`, with the speaker when the transcriber names one.

Provenance quotes are verbatim, and a model quotes the words, not the
stamp in front of them. `evidenceTimestamp` maps a quote back to the
stamped line it came from — matching after collapsing case, whitespace and
curly quotes, and on the line whose tail it starts with when it runs past one —
so a review UI can seek the player to the moment:

```ts
const at = evidenceTimestamp(source.text, provenance.nightlyRate?.evidence);
// → { seconds: 22, timestamp: "00:00:22", line: "[00:00:22] Marta: I'm thinking two forty a night…" }
```

That is the deterministic route, and the one to use. Asking the model to
keep the stamp on its quotes (via `instructions`) was tried and dropped:
it interpolates plausible ones — `[00:00:07]` for a line stamped
`[00:00:00]` — and the quote stops being verbatim. A stamp at the front of
a quote is ignored by `evidenceTimestamp` for that reason. The precision
you get is the precision you rendered: a smaller `segmentSeconds` means a
closer seek.

Options on `audioSource(audio, transcriber, options)`:

- `label` — the source's label, `"Audio"` by default.
- `timestamps` — stamp each segment. Defaults to true when there are
  segments; `false` renders speakers without times.
- `segmentSeconds` — coalesce segments into blocks of about this many
  seconds. A transcriber that emits a segment per sentence gives a timestamp
  per sentence; `segmentSeconds: 30` keeps the text compact while a quote
  still lands within half a minute. Blocks never cross a speaker change.
- `maxDurationSec` — refuse longer recordings with an `AudioSourceError` of
  kind `"too_long"`. Checked before the transcriber is paid for when the
  container makes the duration trivial to read (a WAV header — the one
  container this package reads; nothing is decoded and there is no ffmpeg),
  and again against what the transcriber reports.
- `language`, `prompt` — passed to the transcriber. The prompt is vocabulary
  (names, a product term), not an instruction.
- `header` — drop the header lines.

`transcribeAudio` is the same step returning the transcript itself, and
`renderTranscript`, `coalesceSegments`, `formatTimestamp` and
`wavDurationSec` are exported on their own.

## Long recordings

`audioSources(audio, transcriber, { chunkSeconds: 600 })` returns one source
per ten minutes of transcript, each labelled with the time range it covers —
`Audio 00:10:00–00:20:00` — with the header repeated so a chunk still reads
as part of one recording. SEMBL's budget cuts long sources first, so on a
call that blows `maxInputChars` it trims a stretch rather than the tail, and
with several sources provenance names the stretch a value was read from. A
segment belongs to the chunk its start falls in, so none is cut.

## Cache the transcripts

Transcription is the slow, paid step and has no reason to change between
runs. `withTranscriptCache(transcriber, dir)` wraps any transcriber so each
transcript is written to `dir` as JSON, keyed by a sha256 of the audio bytes
plus the media type and options, and served from there next time:

```ts
const transcriber = withTranscriptCache(new OpenAITranscriber({ apiKey }), ".cache/transcripts");
```

Node only. Paired with `@sembl/testing`'s record/replay, a whole audio
extraction runs offline after its first run. The transcriber is not part of
the key, so give each model its own directory.

## The OpenAI transcriber

```ts
new OpenAITranscriber({ apiKey, model: "whisper-1", segments: true, temperature: 0 });
```

`openai` is a regular dependency of this package, so nothing else is needed.
Pass `client` to call through an instance your app already configured;
`apiKey`, `baseURL`, `maxRetries` (2) and `timeoutMs` (five minutes, since
uploads are not quick) configure a fresh one. Retries and backoff are the
SDK's.

The default model is `whisper-1`: it is the one model on the endpoint that
returns segment timestamps (`verbose_json` with `timestamp_granularities:
["segment"]`) and the recording's duration, and timestamps are the point of
this package. `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` transcribe
more accurately but return prose only; choose one with `model` and the
source has no stamps. `segments: false` asks `whisper-1` for prose as well.

The service sniffs the upload's file name, so it is derived from the media
type (`audio/mpeg` → `.mp3`, `audio/mp4` → `.m4a`, `audio/webm` → `.webm`,
…) unless `filename` already carries a supported extension. Accepted:
flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. The endpoint's own limit
is 25 MB per upload; split longer recordings before transcribing, or
transcribe them chunk by chunk with your own `Transcriber`.

## Errors

Everything throws `AudioSourceError`. Branch on `kind`:

- `"api"` — the service failed. `retryable` is true for a rate limit, an
  outage or a dropped connection, and `status` carries the HTTP status.
- `"unsupported"` — the recording: a media type the service does not take,
  bytes it could not decode, or an empty file.
- `"too_long"` — `maxDurationSec`, or the service's size limit.

The last two do not change on a retry.
