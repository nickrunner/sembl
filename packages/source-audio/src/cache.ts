import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AudioInput, TranscribeOptions, Transcriber, Transcript } from "./transcriber.js";

/** What a cached transcript file holds. */
export interface CachedTranscript {
  /** The hash the file is named by. */
  key: string;
  mediaType: string;
  options: TranscribeOptions;
  transcript: Transcript;
  cachedAt: string;
}

/**
 * The key a recording caches under: a sha256 of the audio bytes, the media
 * type and the transcribe options. The file name never enters it — the same
 * bytes uploaded under two names are the same recording. The transcriber
 * itself is not part of the key either, so give each service or model its
 * own directory.
 */
export function transcriptCacheKey(audio: AudioInput, options: TranscribeOptions = {}): string {
  const hash = createHash("sha256");
  hash.update(audio.data);
  hash.update("\0");
  hash.update(
    JSON.stringify({
      mediaType: audio.mediaType,
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    }),
  );
  return hash.digest("hex").slice(0, 32);
}

/** Where the transcript for a recording lives inside a cache directory. */
export function transcriptCachePath(dir: string, audio: AudioInput, options?: TranscribeOptions): string {
  return join(dir, `${transcriptCacheKey(audio, options)}.json`);
}

/**
 * Wrap a transcriber so every transcript is written to `dir` and served
 * from there on the next call with the same bytes and options. Node only.
 *
 * Transcription is the slow, paid step of an audio pipeline, and unlike a
 * model call it has no reason to change between runs — so a second run of
 * a test suite, a demo, or a re-extraction after a schema change should not
 * pay for it again. Pair it with SEMBL's record/replay and a whole audio
 * example runs offline.
 *
 * A file that fails to parse is treated as a miss and overwritten. The
 * directory is created on the first write.
 */
export function withTranscriptCache(transcriber: Transcriber, dir: string): Transcriber {
  return {
    async transcribe(audio, options) {
      const path = transcriptCachePath(dir, audio, options);
      const hit = readCached(path);
      if (hit) return hit.transcript;

      const transcript = await transcriber.transcribe(audio, options);
      const entry: CachedTranscript = {
        key: transcriptCacheKey(audio, options),
        mediaType: audio.mediaType,
        options: options ?? {},
        transcript,
        cachedAt: new Date().toISOString(),
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(entry, null, 2) + "\n", "utf8");
      return transcript;
    },
  };
}

function readCached(path: string): CachedTranscript | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CachedTranscript>;
    if (parsed && typeof parsed === "object" && parsed.transcript && typeof parsed.transcript.text === "string") {
      return parsed as CachedTranscript;
    }
  } catch {
    // A corrupt cache file is a miss, not a failure.
  }
  return undefined;
}
