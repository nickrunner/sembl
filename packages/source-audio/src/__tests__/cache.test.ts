import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTranscriber, transcriptCacheKey, transcriptCachePath, withTranscriptCache } from "../index.js";
import { scripted } from "./fixtures.js";

const audio = { data: new Uint8Array([1, 2, 3, 4]), mediaType: "audio/mpeg", filename: "a.mp3" };

describe("withTranscriptCache", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "sembl-transcripts-")), "nested");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes on a miss and serves the next call without the transcriber", async () => {
    const inner = new FakeTranscriber(scripted);
    const cached = withTranscriptCache(inner, dir);

    expect(existsSync(dir)).toBe(false);
    const first = await cached.transcribe(audio, { language: "en" });
    expect(first).toEqual(scripted);
    expect(readdirSync(dir)).toEqual([`${transcriptCacheKey(audio, { language: "en" })}.json`]);

    const second = await cached.transcribe(audio, { language: "en" });
    expect(second).toEqual(scripted);
    expect(inner.calls).toHaveLength(1);

    const file = JSON.parse(readFileSync(transcriptCachePath(dir, audio, { language: "en" }), "utf8"));
    expect(file.mediaType).toBe("audio/mpeg");
    expect(file.options).toEqual({ language: "en" });
    expect(file.transcript).toEqual(scripted);
  });

  it("keys on bytes, media type and options but not on the file name", () => {
    const base = transcriptCacheKey(audio);
    expect(transcriptCacheKey({ ...audio, filename: "b.mp3" })).toBe(base);
    expect(transcriptCacheKey({ ...audio, data: new Uint8Array([1, 2, 3, 5]) })).not.toBe(base);
    expect(transcriptCacheKey({ ...audio, mediaType: "audio/wav" })).not.toBe(base);
    expect(transcriptCacheKey(audio, { language: "en" })).not.toBe(base);
    expect(transcriptCacheKey(audio, { prompt: "names" })).not.toBe(base);
    expect(transcriptCacheKey(audio, {})).toBe(base);
  });

  it("treats a corrupt file as a miss and overwrites it", async () => {
    const inner = new FakeTranscriber(scripted);
    const cached = withTranscriptCache(inner, dir);
    const path = transcriptCachePath(dir, audio);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{not json", "utf8");

    expect(await cached.transcribe(audio)).toEqual(scripted);
    expect(inner.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).transcript).toEqual(scripted);

    writeFileSync(path, JSON.stringify({ transcript: { nope: true } }), "utf8");
    expect(await cached.transcribe(audio)).toEqual(scripted);
    expect(inner.calls).toHaveLength(2);
  });
});
