export type {
  AudioInput,
  TranscribeOptions,
  Transcript,
  TranscriptSegment,
  Transcriber,
} from "./transcriber.js";
export { FakeTranscriber } from "./transcriber.js";

export {
  audioSource,
  audioSources,
  transcribeAudio,
  transcriptChunks,
  DEFAULT_LABEL,
} from "./audio-source.js";
export type {
  AudioSourceOptions,
  AudioSourcesOptions,
  TranscribedAudio,
  TranscriptChunk,
} from "./audio-source.js";

export {
  renderTranscript,
  coalesceSegments,
  formatTimestamp,
  transcriptHeader,
  speakersOf,
  evidenceTimestamp,
} from "./render.js";
export type { RenderOptions } from "./render.js";

export { wavDurationSec, isWav } from "./wav.js";

export { withTranscriptCache, transcriptCacheKey, transcriptCachePath } from "./cache.js";
export type { CachedTranscript } from "./cache.js";

export {
  OpenAITranscriber,
  toAudioSourceError,
  uploadName,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from "./openai-transcriber.js";
export type { OpenAITranscriberConfig } from "./openai-transcriber.js";

export { AudioSourceError } from "./errors.js";
export type { AudioSourceErrorKind } from "./errors.js";
