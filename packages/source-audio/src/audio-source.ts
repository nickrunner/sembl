import type { TextSource } from "@sembl/core";
import { AudioSourceError } from "./errors.js";
import { formatTimestamp, renderTranscript, transcriptHeader } from "./render.js";
import type { AudioInput, TranscribeOptions, Transcriber, Transcript, TranscriptSegment } from "./transcriber.js";
import { isWav, wavDurationSec } from "./wav.js";

/** The label a source gets when none is given. */
export const DEFAULT_LABEL = "Audio";

/** Options for {@link audioSource}. */
export interface AudioSourceOptions extends TranscribeOptions {
  /** Where the recording came from, for the model and for provenance. Default "Audio". */
  label?: string;
  /**
   * Stamp each segment with its start time. Defaults to true when the
   * transcriber returns segments; without them there is nothing to stamp.
   */
  timestamps?: boolean;
  /**
   * Refuse recordings longer than this, in seconds. Checked before the
   * transcriber is called when the container makes the duration trivial to
   * read (WAV), and again against what the transcriber reports; either way
   * the error is an {@link AudioSourceError} of kind `"too_long"`.
   */
  maxDurationSec?: number;
  /**
   * Coalesce segments into blocks of about this many seconds. A transcriber
   * that emits a segment per sentence gives a timestamp per sentence, which
   * is more than provenance needs; `segmentSeconds: 30` keeps the text
   * compact while a quote still lands within half a minute.
   */
  segmentSeconds?: number;
  /** Include the `Duration` / `Language` / `Speakers` header. Default true. */
  header?: boolean;
}

/** Options for {@link audioSources}. */
export interface AudioSourcesOptions extends AudioSourceOptions {
  /** How many seconds of the recording each source covers. */
  chunkSeconds: number;
}

/** A transcribed recording: the transcript plus the duration this package worked out. */
export interface TranscribedAudio {
  transcript: Transcript;
  /** From the transcriber when it reports one, else from the container when it is a WAV. */
  durationSec?: number;
}

function tooLong(durationSec: number, maxDurationSec: number, when: string): AudioSourceError {
  return new AudioSourceError(
    `The recording is ${formatTimestamp(durationSec)} long, over the ${formatTimestamp(maxDurationSec)} allowed (${when}).`,
    { kind: "too_long" },
  );
}

/**
 * Transcribe a recording, enforcing `maxDurationSec` before the transcriber
 * is paid for when the duration can be read off the container, and folding
 * the container's duration into the transcript when the transcriber gave
 * none. The building block behind {@link audioSource} and
 * {@link audioSources}; useful on its own when you want the transcript too.
 */
export async function transcribeAudio(
  audio: AudioInput,
  transcriber: Transcriber,
  options: AudioSourceOptions = {},
): Promise<TranscribedAudio> {
  const { maxDurationSec, language, prompt } = options;
  const known = isWav(audio.data) ? wavDurationSec(audio.data) : undefined;
  if (maxDurationSec !== undefined && known !== undefined && known > maxDurationSec) {
    throw tooLong(known, maxDurationSec, "read from the WAV header, before transcription");
  }

  const transcribeOptions: TranscribeOptions = {
    ...(language !== undefined ? { language } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  };
  const raw = await transcriber.transcribe(audio, transcribeOptions);
  const durationSec = raw.durationSec ?? known;
  if (maxDurationSec !== undefined && durationSec !== undefined && durationSec > maxDurationSec) {
    throw tooLong(durationSec, maxDurationSec, "reported by the transcriber");
  }
  const transcript: Transcript = durationSec !== undefined && raw.durationSec === undefined ? { ...raw, durationSec } : raw;
  return durationSec !== undefined ? { transcript, durationSec } : { transcript };
}

/**
 * Build a labelled SEMBL source from a recording, ready to pass to any
 * coercion or to `sembl()`: the transcriber's transcript rendered with a
 * short header and a `[HH:MM:SS]` stamp per segment, so provenance evidence
 * can cite the moment a value was said.
 *
 * ```ts
 * const source = await audioSource(
 *   { data: bytes, mediaType: "audio/mpeg" },
 *   new OpenAITranscriber({ apiKey }),
 *   { label: "Host voice note", segmentSeconds: 20 },
 * );
 * const listing = await partialCoerce<Listing>(source, { provider, schema });
 * ```
 */
export async function audioSource(
  audio: AudioInput,
  transcriber: Transcriber,
  options: AudioSourceOptions = {},
): Promise<TextSource> {
  const { transcript } = await transcribeAudio(audio, transcriber, options);
  return {
    label: options.label ?? DEFAULT_LABEL,
    text: renderTranscript(transcript, {
      timestamps: options.timestamps,
      segmentSeconds: options.segmentSeconds,
      header: options.header,
    }),
  };
}

/** One stretch of a transcript, as produced by {@link transcriptChunks}. */
export interface TranscriptChunk {
  /** Where this chunk starts, in seconds. */
  start: number;
  /** Where this chunk ends, in seconds. */
  end: number;
  /** The segments that fall in it, as a transcript of their own. */
  transcript: Transcript;
}

/**
 * Split a transcript's segments onto a grid of `chunkSeconds`, by start
 * time. A segment belongs to the chunk its start falls in, so no segment
 * is cut. Grid cells with no speech are skipped; the last cell ends at the
 * recording's duration when that is known.
 */
export function transcriptChunks(transcript: Transcript, chunkSeconds: number): TranscriptChunk[] {
  if (!(chunkSeconds > 0)) throw new RangeError("chunkSeconds must be a positive number of seconds");
  const segments = transcript.segments ?? [];
  const cells = new Map<number, TranscriptSegment[]>();
  for (const segment of segments) {
    if (!segment.text.trim()) continue;
    const index = Math.floor(Math.max(0, segment.start) / chunkSeconds);
    const cell = cells.get(index);
    if (cell) cell.push(segment);
    else cells.set(index, [segment]);
  }
  const chunks: TranscriptChunk[] = [];
  const indices = [...cells.keys()].sort((a, b) => a - b);
  const last = indices[indices.length - 1];
  for (const index of indices) {
    const cell = cells.get(index)!;
    const start = index * chunkSeconds;
    let end = (index + 1) * chunkSeconds;
    if (index === last) {
      const spoken = Math.max(...cell.map((s) => s.end));
      end = transcript.durationSec !== undefined ? Math.max(transcript.durationSec, spoken) : Math.max(end, spoken);
    }
    const chunk: Transcript = { text: cell.map((s) => s.text.trim()).join(" "), segments: cell };
    if (transcript.language) chunk.language = transcript.language;
    chunks.push({ start, end, transcript: chunk });
  }
  return chunks;
}

/**
 * A long recording as one source per `chunkSeconds` of transcript, each
 * labelled with the time range it covers — `Call 00:10:00–00:20:00` — so
 * SEMBL's budget, which cuts long sources first, trims a stretch of the
 * call rather than its tail, and provenance names the stretch a value was
 * read from. Every chunk carries the header, so a chunk still reads as
 * part of one recording when the others were cut.
 *
 * A transcript without segments cannot be chunked by time and comes back
 * as the single source {@link audioSource} would have built.
 */
export async function audioSources(
  audio: AudioInput,
  transcriber: Transcriber,
  options: AudioSourcesOptions,
): Promise<TextSource[]> {
  const { chunkSeconds, label = DEFAULT_LABEL, header = true } = options;
  const { transcript } = await transcribeAudio(audio, transcriber, options);
  const chunks = transcriptChunks(transcript, chunkSeconds);
  if (chunks.length === 0) {
    return [{ label, text: renderTranscript(transcript, { timestamps: options.timestamps, header }) }];
  }
  const headLines = header ? transcriptHeader(transcript) : [];
  return chunks.map((chunk, i) => {
    const range = `${formatTimestamp(chunk.start)}–${formatTimestamp(chunk.end)}`;
    const body = renderTranscript(chunk.transcript, {
      timestamps: options.timestamps,
      segmentSeconds: options.segmentSeconds,
      header: false,
    });
    const head = header ? [`Part ${i + 1} of ${chunks.length}, ${range}`, ...headLines] : [];
    return {
      label: `${label} ${range}`,
      text: head.length > 0 ? `${head.join("\n")}\n\n${body}` : body,
    };
  });
}
