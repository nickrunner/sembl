import OpenAI, { APIConnectionError, APIError, toFile } from "openai";
import { AudioSourceError } from "./errors.js";
import type { AudioInput, TranscribeOptions, Transcriber, Transcript, TranscriptSegment } from "./transcriber.js";

/** Configuration for {@link OpenAITranscriber}. */
export interface OpenAITranscriberConfig {
  /**
   * Which transcription model to call. Defaults to {@link DEFAULT_TRANSCRIPTION_MODEL},
   * `whisper-1` — the one model in the current API that returns segment
   * timestamps and the recording's duration, which is what makes a source
   * citable by time. `gpt-4o-transcribe` and `gpt-4o-mini-transcribe`
   * transcribe more accurately but return prose only, so a source built from
   * them has no timestamps.
   */
  model?: string;
  /**
   * An existing client to call through — the same instance your app already
   * configured, or a fake in tests. When given, `apiKey`, `baseURL`,
   * `maxRetries` and `timeoutMs` are ignored.
   */
  client?: OpenAI;
  /** OpenAI API key. Defaults to the `OPENAI_API_KEY` environment variable. */
  apiKey?: string;
  /** Base URL for the API, for a proxy or a compatible service. */
  baseURL?: string;
  /** How many times the SDK retries a failed call. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  maxRetries?: number;
  /** Timeout for a single attempt, in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Ask for segment timestamps. Defaults to true for `whisper-1` and false
   * otherwise, since the other models reject `verbose_json`. Set it to false
   * to get the plain transcript from `whisper-1` as well.
   */
  segments?: boolean;
  /**
   * Sampling temperature, 0–1. Left unset the service picks; `0` makes a
   * transcript as repeatable as the model allows.
   */
  temperature?: number;
}

/** The model {@link OpenAITranscriber} calls unless told otherwise. */
export const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";
/** Matches the SDK's own default; stated here so it survives an SDK change. */
export const DEFAULT_MAX_RETRIES = 2;
/** Five minutes per attempt: uploads of a long recording are not quick. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The containers OpenAI's transcription endpoint accepts, by media type,
 * with the extension the upload is named by. The service sniffs the name,
 * so an unnamed upload has to be given the right one.
 */
const EXTENSIONS: Record<string, string> = {
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mpga",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "video/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/oga": "ogg",
  "audio/opus": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/webm": "webm",
  "video/webm": "webm",
};

const SUPPORTED_EXTENSIONS = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);

/** The name to upload a recording under, or undefined when its format is not one the service takes. */
export function uploadName(audio: AudioInput): string | undefined {
  const fromName = audio.filename?.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
  if (fromName && SUPPORTED_EXTENSIONS.has(fromName)) return audio.filename;
  const ext = EXTENSIONS[audio.mediaType.toLowerCase().split(";")[0].trim()];
  if (!ext) return undefined;
  const stem = audio.filename?.replace(/\.[A-Za-z0-9]+$/, "") || "audio";
  return `${stem}.${ext}`;
}

/**
 * A {@link Transcriber} over OpenAI's `audio.transcriptions` endpoint.
 *
 * Retries and timeouts are the SDK's (exponential backoff, `retry-after`
 * aware); this class chooses the numbers, names the upload so the service
 * can sniff its format, asks for timestamps when the model can give them,
 * and translates whatever comes back out into an {@link AudioSourceError}.
 */
export class OpenAITranscriber implements Transcriber {
  private readonly client: OpenAI;
  private readonly config: OpenAITranscriberConfig;

  constructor(config: OpenAITranscriberConfig = {}) {
    this.config = config;
    this.client =
      config.client ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
  }

  /** The model this transcriber calls. */
  get model(): string {
    return this.config.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  }

  /** Whether calls ask for segment timestamps. */
  get segments(): boolean {
    return this.config.segments ?? this.model === "whisper-1";
  }

  async transcribe(audio: AudioInput, options: TranscribeOptions = {}): Promise<Transcript> {
    if (audio.data.length === 0) {
      throw new AudioSourceError("The recording is empty: no bytes to transcribe.", { kind: "unsupported" });
    }
    const name = uploadName(audio);
    if (!name) {
      throw new AudioSourceError(
        `OpenAI transcription does not accept "${audio.mediaType}". ` +
          `Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")} — pass a filename with one of those extensions if the media type is wrong.`,
        { kind: "unsupported" },
      );
    }

    const file = await toFile(audio.data, name, { type: audio.mediaType });
    const common = {
      file,
      model: this.model,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
    };

    try {
      if (this.segments) {
        const verbose = await this.client.audio.transcriptions.create({
          ...common,
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
        });
        return fromVerbose(verbose);
      }
      const plain = await this.client.audio.transcriptions.create({ ...common, response_format: "json" });
      return { text: plain.text.trim() };
    } catch (error) {
      throw toAudioSourceError(error);
    }
  }
}

/** The shape of a `verbose_json` answer, named loosely so an SDK change does not break the build. */
interface VerboseTranscription {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string }>;
}

function fromVerbose(verbose: VerboseTranscription): Transcript {
  const transcript: Transcript = { text: verbose.text.trim() };
  if (verbose.language) transcript.language = verbose.language;
  if (typeof verbose.duration === "number" && Number.isFinite(verbose.duration)) transcript.durationSec = verbose.duration;
  if (verbose.segments && verbose.segments.length > 0) {
    transcript.segments = verbose.segments.map(
      (s): TranscriptSegment => ({ start: s.start, end: s.end, text: s.text.trim() }),
    );
  }
  return transcript;
}

/**
 * Wrap an SDK-level failure as an {@link AudioSourceError}.
 *
 * Retryability is read off the SDK's own error classes rather than the
 * message: connection failures and timeouts are transient by construction,
 * and of the status codes only 408/409/429 and 5xx are worth another
 * attempt — the same set the SDK itself retries internally. A 413, or a 400
 * whose message names the format or the length, is the recording's fault
 * and is classified as such.
 */
export function toAudioSourceError(error: unknown): AudioSourceError {
  if (error instanceof AudioSourceError) return error;
  if (error instanceof APIError) {
    const status = error.status;
    // The SDK prefixes the body's message with the status; it is reported once, below.
    const message = status ? error.message.replace(new RegExp(`^${status} `), "") : error.message;
    if (status === 413 || /too (?:long|large)|maximum content size|exceeds? the (?:maximum|limit)/i.test(message)) {
      return new AudioSourceError(`OpenAI rejected the recording as too long${status ? ` (${status})` : ""}: ${message}`, {
        kind: "too_long",
        status,
        cause: error,
      });
    }
    if (status === 415 || (status === 400 && /format|decode|unsupported|invalid file|corrupt/i.test(message))) {
      return new AudioSourceError(`OpenAI could not read the recording${status ? ` (${status})` : ""}: ${message}`, {
        kind: "unsupported",
        status,
        cause: error,
      });
    }
    const retryable =
      error instanceof APIConnectionError ||
      status === undefined ||
      status === 408 ||
      status === 409 ||
      status === 429 ||
      status >= 500;
    return new AudioSourceError(`OpenAI transcription failed${status ? ` (${status})` : ""}: ${message}`, {
      kind: "api",
      retryable,
      status,
      cause: error,
    });
  }
  return new AudioSourceError(
    `OpenAI transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    { kind: "api", retryable: false, cause: error },
  );
}
