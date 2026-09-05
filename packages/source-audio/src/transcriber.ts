/**
 * The seam this package is built around.
 *
 * SEMBL's providers do structured output from text, so audio has to become
 * text first. That step is a {@link Transcriber}: anything that turns bytes
 * into a {@link Transcript}. The package ships one for OpenAI and a scripted
 * one for tests; a self-hosted Whisper, Deepgram, or a phone-system export
 * fits the same interface, and everything downstream — rendering, chunking,
 * caching — never sees which one it was.
 */

/** A recording, as bytes plus enough to tell a service what they are. */
export interface AudioInput {
  /** The raw file contents. */
  data: Uint8Array;
  /** The MIME type — `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/webm`, … */
  mediaType: string;
  /**
   * The original file name, when known. Its extension is used ahead of the
   * media type to name the upload, since a service usually sniffs that.
   */
  filename?: string;
}

/** Hints a transcriber may pass to its service. */
export interface TranscribeOptions {
  /** The language spoken, as an ISO 639-1 code. Improves accuracy and latency when known. */
  language?: string;
  /**
   * Text that guides the style or vocabulary — names, a product term, the
   * previous segment of a longer recording. Not an instruction.
   */
  prompt?: string;
}

/** One stretch of speech with the seconds it spans. */
export interface TranscriptSegment {
  /** Start of the segment, in seconds from the top of the recording. */
  start: number;
  /** End of the segment, in seconds. */
  end: number;
  /** What was said. */
  text: string;
  /** Who said it, when the transcriber diarises. */
  speaker?: string;
}

/** What a transcriber returns. Only `text` is guaranteed. */
export interface Transcript {
  /** The whole transcript as prose. */
  text: string;
  /**
   * The language detected or given, as the transcriber reports it — an ISO
   * 639-1 code from most services, a name such as `english` from whisper-1.
   * Rendered into the header as is.
   */
  language?: string;
  /** Length of the recording in seconds, when the transcriber reports it. */
  durationSec?: number;
  /** Timed segments, in order. Without them the source has no timestamps. */
  segments?: TranscriptSegment[];
}

/** Turns audio into a transcript. Implement this to bring your own service. */
export interface Transcriber {
  transcribe(audio: AudioInput, options?: TranscribeOptions): Promise<Transcript>;
}

/**
 * A transcriber that answers with a transcript you wrote. For tests, demos
 * and record/replay: pass a {@link Transcript}, or a function of the audio
 * and options when a test needs to see what was asked.
 */
export class FakeTranscriber implements Transcriber {
  /** Every request made, oldest first. */
  readonly calls: Array<{ audio: AudioInput; options: TranscribeOptions | undefined }> = [];

  constructor(
    private readonly script:
      | Transcript
      | ((audio: AudioInput, options?: TranscribeOptions) => Transcript | Promise<Transcript>),
  ) {}

  async transcribe(audio: AudioInput, options?: TranscribeOptions): Promise<Transcript> {
    this.calls.push({ audio, options });
    return typeof this.script === "function" ? this.script(audio, options) : this.script;
  }
}
