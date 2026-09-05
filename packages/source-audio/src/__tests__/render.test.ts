import { describe, it, expect } from "vitest";
import {
  coalesceSegments,
  evidenceTimestamp,
  formatTimestamp,
  renderTranscript,
  speakersOf,
  transcriptHeader,
} from "../index.js";
import { scripted } from "./fixtures.js";

describe("formatTimestamp", () => {
  it("always renders HH:MM:SS, flooring fractions", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(75.9)).toBe("00:01:15");
    expect(formatTimestamp(3661)).toBe("01:01:01");
    expect(formatTimestamp(-3)).toBe("00:00:00");
  });
});

describe("renderTranscript", () => {
  it("renders a header and one stamped line per segment", () => {
    expect(renderTranscript(scripted)).toBe(
      [
        "Duration: 00:01:35",
        "Language: en",
        "Speakers: Host, Agent",
        "",
        "[00:00:00] Host: Hi, it's Marta about the lakehouse.",
        "[00:00:04] Host: It sleeps eight.",
        "[00:01:15] Host: Two forty a night in euros.",
        "[00:01:28] Agent: Great, thanks.",
      ].join("\n"),
    );
  });

  it("keeps speakers but drops stamps with timestamps: false", () => {
    const text = renderTranscript(scripted, { timestamps: false });
    expect(text).not.toContain("[00:");
    expect(text).toContain("Host: It sleeps eight.");
    expect(text).toContain("Agent: Great, thanks.");
  });

  it("falls back to the prose when there are no segments", () => {
    const text = renderTranscript({ text: "  Just prose.  ", durationSec: 12 });
    expect(text).toBe("Duration: 00:00:12\n\nJust prose.");
  });

  it("uses the prose when timestamps are off and nobody is named", () => {
    const text = renderTranscript(
      { text: "One. Two.", segments: [{ start: 0, end: 1, text: "One." }, { start: 1, end: 2, text: "Two." }] },
      { timestamps: false },
    );
    expect(text).toBe("One. Two.");
  });

  it("omits the header entirely when nothing is known or header is off", () => {
    expect(renderTranscript({ text: "Hi." })).toBe("Hi.");
    expect(renderTranscript(scripted, { header: false }).startsWith("[00:00:00]")).toBe(true);
  });

  it("only lists the header facts that are known", () => {
    expect(transcriptHeader({ text: "x", language: "de" })).toEqual(["Language: de"]);
    expect(speakersOf([{ start: 0, end: 1, text: "a" }])).toEqual([]);
  });

  it("coalesces segments into blocks of about N seconds", () => {
    const text = renderTranscript(scripted, { segmentSeconds: 30, header: false });
    expect(text.split("\n")).toEqual([
      "[00:00:00] Host: Hi, it's Marta about the lakehouse. It sleeps eight.",
      "[00:01:15] Host: Two forty a night in euros.",
      "[00:01:28] Agent: Great, thanks.",
    ]);
  });
});

describe("evidenceTimestamp", () => {
  const text = renderTranscript(scripted, { segmentSeconds: 30 });

  it("finds the stamped line a verbatim quote came from", () => {
    expect(evidenceTimestamp(text, "Two forty a night in euros.")).toEqual({
      seconds: 75,
      timestamp: "00:01:15",
      line: "[00:01:15] Host: Two forty a night in euros.",
    });
  });

  it("ignores case, whitespace and curly quotes", () => {
    expect(evidenceTimestamp(text, "  it’s  MARTA about the lakehouse")?.seconds).toBe(0);
  });

  it("uses the line's stamp, not one the model put on the quote", () => {
    expect(evidenceTimestamp(text, "[00:01:28] Agent: Great, thanks.")?.seconds).toBe(88);
    // A model asked for stamps interpolates them; the line is the truth.
    expect(evidenceTimestamp(text, "[00:01:20] Two forty a night in euros.")?.timestamp).toBe("00:01:15");
  });

  it("locates a quote that runs past its line on the line whose tail it starts with", () => {
    expect(evidenceTimestamp(text, "Two forty a night in euros. Great, thanks.")?.seconds).toBe(75);
    expect(evidenceTimestamp(text, "It sleeps eight. Two forty a night")?.seconds).toBe(0);
    // A tail that is too short to be a match is not one.
    expect(evidenceTimestamp(text, "eight. Never said this")).toBeUndefined();
  });

  it("is undefined for a missing quote, an unstamped source or no evidence", () => {
    expect(evidenceTimestamp(text, "never said")).toBeUndefined();
    expect(evidenceTimestamp("Duration: 00:00:05\n\nJust prose.", "Just prose.")).toBeUndefined();
    expect(evidenceTimestamp(text, undefined)).toBeUndefined();
    expect(evidenceTimestamp(text, "")).toBeUndefined();
  });
});

describe("coalesceSegments", () => {
  it("closes a block on the time budget and keeps the last end", () => {
    const blocks = coalesceSegments(
      [
        { start: 0, end: 10, text: "a" },
        { start: 10, end: 20, text: "b" },
        { start: 20, end: 31, text: "c" },
        { start: 31, end: 40, text: "d" },
      ],
      30,
    );
    expect(blocks).toEqual([
      { start: 0, end: 20, text: "a b" },
      { start: 20, end: 40, text: "c d" },
    ]);
  });

  it("closes a block when the speaker changes and skips empty segments", () => {
    const blocks = coalesceSegments(
      [
        { start: 0, end: 1, text: "a", speaker: "A" },
        { start: 1, end: 2, text: "   " },
        { start: 2, end: 3, text: "b", speaker: "B" },
        { start: 3, end: 4, text: "c", speaker: "B" },
      ],
      60,
    );
    expect(blocks).toEqual([
      { start: 0, end: 1, text: "a", speaker: "A" },
      { start: 2, end: 4, text: "b c", speaker: "B" },
    ]);
  });

  it("returns the segments as they are for a non-positive budget", () => {
    expect(coalesceSegments(scripted.segments!, 0)).toEqual(scripted.segments);
  });
});
