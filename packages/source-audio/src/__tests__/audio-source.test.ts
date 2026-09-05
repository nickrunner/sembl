import { describe, it, expect } from "vitest";
import { budgetSources } from "@sembl/core";
import {
  AudioSourceError,
  FakeTranscriber,
  audioSource,
  audioSources,
  transcribeAudio,
  transcriptChunks,
} from "../index.js";
import { scripted, silentWav } from "./fixtures.js";

const mp3 = { data: new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), mediaType: "audio/mpeg" };

describe("audioSource", () => {
  it("builds a labelled, timestamped source and passes the hints through", async () => {
    const transcriber = new FakeTranscriber(scripted);
    const source = await audioSource(mp3, transcriber, { label: "Voice note", language: "en", prompt: "Marta" });
    expect(source.label).toBe("Voice note");
    expect(source.text).toContain("Duration: 00:01:35");
    expect(source.text).toContain("[00:01:15] Host: Two forty a night in euros.");
    expect(transcriber.calls).toEqual([{ audio: mp3, options: { language: "en", prompt: "Marta" } }]);
  });

  it("defaults the label and drops stamps on request", async () => {
    const source = await audioSource(mp3, new FakeTranscriber(scripted), { timestamps: false });
    expect(source.label).toBe("Audio");
    expect(source.text).not.toContain("[00:");
  });

  it("coalesces segments with segmentSeconds", async () => {
    const source = await audioSource(mp3, new FakeTranscriber(scripted), { segmentSeconds: 30, header: false });
    expect(source.text.split("\n")).toHaveLength(3);
  });

  it("fills the duration in from a WAV header when the transcriber gives none", async () => {
    const wav = { data: silentWav(2.5), mediaType: "audio/wav" };
    const { transcript, durationSec } = await transcribeAudio(wav, new FakeTranscriber({ text: "Hello." }));
    expect(durationSec).toBe(2.5);
    expect(transcript.durationSec).toBe(2.5);
    const source = await audioSource(wav, new FakeTranscriber({ text: "Hello." }));
    expect(source.text).toBe("Duration: 00:00:02\n\nHello.");
  });

  it("prefers the transcriber's duration over the container's", async () => {
    const wav = { data: silentWav(2.5), mediaType: "audio/wav" };
    const { durationSec } = await transcribeAudio(wav, new FakeTranscriber({ text: "Hello.", durationSec: 3 }));
    expect(durationSec).toBe(3);
  });

  it("refuses a too-long WAV before calling the transcriber", async () => {
    const transcriber = new FakeTranscriber(scripted);
    const wav = { data: silentWav(61), mediaType: "audio/wav" };
    const error = await audioSource(wav, transcriber, { maxDurationSec: 60 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AudioSourceError);
    expect((error as AudioSourceError).kind).toBe("too_long");
    expect((error as AudioSourceError).retryable).toBe(false);
    expect((error as AudioSourceError).message).toContain("00:01:01");
    expect(transcriber.calls).toHaveLength(0);
  });

  it("refuses a recording the transcriber reports as too long", async () => {
    const error = await audioSource(mp3, new FakeTranscriber(scripted), { maxDurationSec: 90 }).catch((e: unknown) => e);
    expect((error as AudioSourceError).kind).toBe("too_long");
    expect((error as AudioSourceError).message).toContain("reported by the transcriber");
  });

  it("lets a recording of unknown length through under maxDurationSec", async () => {
    const source = await audioSource(mp3, new FakeTranscriber({ text: "Hi." }), { maxDurationSec: 1 });
    expect(source.text).toBe("Hi.");
  });
});

describe("transcriptChunks", () => {
  it("puts each segment in the grid cell its start falls in and skips silent cells", () => {
    const chunks = transcriptChunks(scripted, 30);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 30],
      [60, 95],
    ]);
    expect(chunks[0].transcript.segments).toHaveLength(2);
    expect(chunks[0].transcript.text).toBe("Hi, it's Marta about the lakehouse. It sleeps eight.");
    expect(chunks[1].transcript.segments!.map((s) => s.start)).toEqual([75, 88]);
    expect(chunks[1].transcript.language).toBe("en");
  });

  it("ends the last chunk at the last segment when the duration is unknown", () => {
    const chunks = transcriptChunks({ ...scripted, durationSec: undefined }, 60);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([
      [0, 60],
      [60, 120],
    ]);
    expect(transcriptChunks({ text: "x", segments: [{ start: 10, end: 70, text: "long" }] }, 60)[0].end).toBe(70);
  });

  it("rejects a non-positive chunk size and handles no segments", () => {
    expect(() => transcriptChunks(scripted, 0)).toThrow(RangeError);
    expect(transcriptChunks({ text: "prose" }, 60)).toEqual([]);
  });
});

describe("audioSources", () => {
  it("returns one source per chunk, labelled with its range and carrying the header", async () => {
    const sources = await audioSources(mp3, new FakeTranscriber(scripted), { chunkSeconds: 30, label: "Call" });
    expect(sources.map((s) => s.label)).toEqual(["Call 00:00:00–00:00:30", "Call 00:01:00–00:01:35"]);
    expect(sources[1].text).toBe(
      [
        "Part 2 of 2, 00:01:00–00:01:35",
        "Duration: 00:01:35",
        "Language: en",
        "Speakers: Host, Agent",
        "",
        "[00:01:15] Host: Two forty a night in euros.",
        "[00:01:28] Agent: Great, thanks.",
      ].join("\n"),
    );
  });

  it("can drop the header and stamps per chunk", async () => {
    const sources = await audioSources(mp3, new FakeTranscriber(scripted), { chunkSeconds: 30, header: false, timestamps: false });
    expect(sources[1].text).toBe("Host: Two forty a night in euros.\nAgent: Great, thanks.");
  });

  it("falls back to a single source when there are no segments", async () => {
    const sources = await audioSources(mp3, new FakeTranscriber({ text: "Prose only.", durationSec: 40 }), { chunkSeconds: 10 });
    expect(sources).toEqual([{ label: "Audio", text: "Duration: 00:00:40\n\nProse only." }]);
  });

  it("lets SEMBL's budget trim one chunk without touching the others", async () => {
    const long = {
      ...scripted,
      segments: [
        ...scripted.segments!,
        { start: 100, end: 160, text: "filler ".repeat(300).trim(), speaker: "Host" },
      ],
      durationSec: 160,
    };
    const sources = await audioSources(mp3, new FakeTranscriber(long), { chunkSeconds: 30 });
    const budgeted = budgetSources(sources, 900).sources;
    expect(budgeted[0].text).toContain("[00:00:00] Host: Hi, it's Marta");
    expect(budgeted[0].text).not.toContain("characters omitted");
    expect(budgeted[budgeted.length - 1].text).toContain("characters omitted");
  });
});
