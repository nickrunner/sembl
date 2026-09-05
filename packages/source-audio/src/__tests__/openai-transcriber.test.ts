import { describe, it, expect, vi } from "vitest";
import { APIConnectionError, APIError } from "openai";
import type OpenAI from "openai";
import {
  AudioSourceError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  OpenAITranscriber,
  toAudioSourceError,
  uploadName,
} from "../index.js";

// Only the client is faked: the SDK's real error classes and `toFile` stay
// in place, since the transcriber branches on the former and uploads through
// the latter.
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return {
    ...actual,
    default: class MockOpenAI {
      options: Record<string, unknown>;
      audio = { transcriptions: { create: vi.fn() } };

      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
    },
  };
});

type FakeClient = {
  options: Record<string, unknown>;
  audio: { transcriptions: { create: ReturnType<typeof vi.fn> } };
};

function fakeClient(transcriber: OpenAITranscriber): FakeClient {
  return (transcriber as unknown as { client: FakeClient }).client;
}

/** As the SDK builds one from a response: the message lives in the error body. */
function apiError(status: number, message: string) {
  return new APIError(status, { type: "invalid_request_error", message }, undefined, undefined);
}

const wav = { data: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]), mediaType: "audio/wav" };

describe("OpenAITranscriber", () => {
  it("applies retry and timeout defaults and the whisper-1 model", () => {
    const transcriber = new OpenAITranscriber({ apiKey: "k" });
    expect(fakeClient(transcriber).options).toMatchObject({
      apiKey: "k",
      maxRetries: DEFAULT_MAX_RETRIES,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    expect(transcriber.model).toBe("whisper-1");
    expect(transcriber.segments).toBe(true);
  });

  it("asks whisper-1 for verbose_json with segment timestamps and maps the answer", async () => {
    const transcriber = new OpenAITranscriber({ apiKey: "k" });
    const create = fakeClient(transcriber).audio.transcriptions.create;
    create.mockResolvedValue({
      text: " Hi there. Bye. ",
      language: "english",
      duration: 4.2,
      segments: [
        { id: 0, start: 0, end: 2, text: " Hi there.", avg_logprob: -0.1 },
        { id: 1, start: 2, end: 4.2, text: " Bye. " },
      ],
    });

    const transcript = await transcriber.transcribe({ ...wav, filename: "note.wav" }, { language: "en", prompt: "Marta" });

    expect(transcript).toEqual({
      text: "Hi there. Bye.",
      language: "english",
      durationSec: 4.2,
      segments: [
        { start: 0, end: 2, text: "Hi there." },
        { start: 2, end: 4.2, text: "Bye." },
      ],
    });
    const sent = create.mock.calls[0][0];
    expect(sent).toMatchObject({
      model: "whisper-1",
      language: "en",
      prompt: "Marta",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
    expect(sent.file.name).toBe("note.wav");
    expect(sent.file.type).toBe("audio/wav");
    expect(sent).not.toHaveProperty("temperature");
  });

  it("asks other models for plain json and returns prose only", async () => {
    const transcriber = new OpenAITranscriber({ apiKey: "k", model: "gpt-4o-transcribe", temperature: 0 });
    const create = fakeClient(transcriber).audio.transcriptions.create;
    create.mockResolvedValue({ text: "Plain prose." });

    expect(transcriber.segments).toBe(false);
    expect(await transcriber.transcribe({ data: wav.data, mediaType: "audio/mpeg" })).toEqual({ text: "Plain prose." });
    const sent = create.mock.calls[0][0];
    expect(sent).toMatchObject({ model: "gpt-4o-transcribe", response_format: "json", temperature: 0 });
    expect(sent).not.toHaveProperty("timestamp_granularities");
    expect(sent.file.name).toBe("audio.mp3");
  });

  it("calls through an injected client and honours segments: false", async () => {
    const create = vi.fn().mockResolvedValue({ text: "Via client." });
    const client = { audio: { transcriptions: { create } } } as unknown as OpenAI;
    const transcriber = new OpenAITranscriber({ client, segments: false });
    expect(await transcriber.transcribe(wav)).toEqual({ text: "Via client." });
    expect(create.mock.calls[0][0].response_format).toBe("json");
  });

  it("refuses an unsupported media type or empty audio before uploading", async () => {
    const transcriber = new OpenAITranscriber({ apiKey: "k" });
    const create = fakeClient(transcriber).audio.transcriptions.create;

    const unsupported = await transcriber.transcribe({ data: wav.data, mediaType: "audio/aiff" }).catch((e: unknown) => e);
    expect(unsupported).toBeInstanceOf(AudioSourceError);
    expect((unsupported as AudioSourceError).kind).toBe("unsupported");

    const empty = await transcriber.transcribe({ data: new Uint8Array(), mediaType: "audio/wav" }).catch((e: unknown) => e);
    expect((empty as AudioSourceError).kind).toBe("unsupported");
    expect(create).not.toHaveBeenCalled();
  });

  it("maps SDK failures to AudioSourceError by kind and retryability", async () => {
    const transcriber = new OpenAITranscriber({ apiKey: "k" });
    const create = fakeClient(transcriber).audio.transcriptions.create;
    const attempt = async (error: unknown): Promise<AudioSourceError> => {
      create.mockRejectedValueOnce(error);
      try {
        await transcriber.transcribe(wav);
      } catch (e) {
        return e as AudioSourceError;
      }
      throw new Error("expected the transcription to fail");
    };

    const limited = await attempt(apiError(429, "Rate limit reached"));
    expect(limited).toBeInstanceOf(AudioSourceError);
    expect(limited).toMatchObject({ kind: "api", retryable: true, status: 429 });
    expect(limited.message).toBe("OpenAI transcription failed (429): Rate limit reached");
    expect(limited.cause).toBeInstanceOf(APIError);

    expect(await attempt(apiError(500, "boom"))).toMatchObject({ kind: "api", retryable: true, status: 500 });
    expect(await attempt(apiError(401, "bad key"))).toMatchObject({ kind: "api", retryable: false, status: 401 });
    expect(await attempt(new APIConnectionError({ message: "socket hang up" }))).toMatchObject({ kind: "api", retryable: true });

    expect(await attempt(apiError(400, "Invalid file format. Supported formats: flac, m4a, ..."))).toMatchObject({
      kind: "unsupported",
      retryable: false,
      status: 400,
    });
    expect(await attempt(apiError(413, "Maximum content size limit (26214400) exceeded"))).toMatchObject({
      kind: "too_long",
      retryable: false,
      status: 413,
    });
    expect(await attempt(apiError(400, "Audio file is too long"))).toMatchObject({ kind: "too_long" });

    const other = await attempt(new Error("aborted"));
    expect(other).toMatchObject({ kind: "api", retryable: false });
    expect(other.message).toContain("aborted");
  });

  it("passes an AudioSourceError through toAudioSourceError untouched", () => {
    const error = new AudioSourceError("x", { kind: "too_long" });
    expect(toAudioSourceError(error)).toBe(error);
  });
});

describe("uploadName", () => {
  it("keeps a supported file name, derives one from the media type, and rejects the rest", () => {
    expect(uploadName({ data: wav.data, mediaType: "audio/wav", filename: "Call 1.WAV" })).toBe("Call 1.WAV");
    expect(uploadName({ data: wav.data, mediaType: "audio/mp4", filename: "memo.bin" })).toBe("memo.m4a");
    expect(uploadName({ data: wav.data, mediaType: "audio/webm;codecs=opus" })).toBe("audio.webm");
    expect(uploadName({ data: wav.data, mediaType: "audio/mpeg", filename: "note.mp3" })).toBe("note.mp3");
    expect(uploadName({ data: wav.data, mediaType: "application/octet-stream" })).toBeUndefined();
  });
});
