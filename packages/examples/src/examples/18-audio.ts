import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { partialCoerceWithProvenance } from "@sembl/core";
import {
  FakeTranscriber,
  OpenAITranscriber,
  audioSource,
  audioSources,
  evidenceTimestamp,
  wavDurationSec,
  withTranscriptCache,
} from "@sembl/source-audio";
import type { AudioInput, Transcriber, Transcript } from "@sembl/source-audio";
import { Listing } from "../support/listing-runtime.js";
import { examplesPath } from "../support/env.js";
import { demoProvider, enumResolver, recordingsDir } from "../support/provider.js";
import { heading, note, show, ok, warn, table } from "../support/print.js";

export const title = "Audio: a host's voice note through a pluggable transcriber";

/**
 * What a transcriber would return for Marta's voice note. The script is
 * what the live path produces from `data/host-voice-note.wav`; here it
 * stands in so the example runs without a key or a recording.
 */
const voiceNote: Transcript = {
  text: "",
  language: "en",
  durationSec: 72,
  segments: [
    { start: 0, end: 6, text: "Hi, it's Marta. Quick voice note about the lakehouse before you write it up." },
    { start: 6, end: 13, text: "Call it Birch Point Lakehouse, that's what the sign at the road says." },
    { start: 13, end: 22, text: "It sleeps eight — six in the bedrooms, and the sofa bed in the living room takes two more." },
    { start: 22, end: 31, text: "I'm thinking two hundred and forty a night, and that's in euros, we're in Finland after all." },
    { start: 31, end: 42, text: "There's a wood-fired sauna down by the water, two kayaks guests can take out, fast wifi, and a proper kitchen with an oven." },
    { start: 42, end: 49, text: "No pets, sorry — my brother is allergic and he does the cleaning." },
    { start: 49, end: 58, text: "The address is Koivurannantie 14, that's in Tampere, postcode 33100... no wait, 34130, the postcode is 34130." },
    { start: 58, end: 66, text: "Oh, and there's an old rowing boat too but it leaks, so don't mention that." },
    { start: 66, end: 72, text: "That's it, ring me if you need anything else. Bye!" },
  ].map((s) => ({ ...s, speaker: "Marta" })),
};
voiceNote.text = voiceNote.segments!.map((s) => s.text).join(" ");

/** A silent PCM WAV of `seconds`: enough of a container for the header reader, nothing to decode. */
function silentWav(seconds: number, sampleRate = 8000): Uint8Array {
  const dataBytes = seconds * sampleRate * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, dataBytes, true);
  return bytes;
}

/**
 * The transcriber is the pluggable part. With a key and a real recording
 * in `data/`, OpenAI transcribes it — once, since the transcript is cached
 * beside the recordings. Otherwise a scripted transcript stands in, the
 * same way a test would.
 */
function pickTranscriber(): { transcriber: Transcriber; audio: AudioInput; how: string } {
  const recording = ["wav", "mp3", "m4a"].map((ext) => examplesPath("data", `host-voice-note.${ext}`)).find(existsSync);
  if (process.env["OPENAI_API_KEY"] && recording) {
    const ext = recording.split(".").pop()!;
    const mediaType = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4" }[ext]!;
    return {
      transcriber: withTranscriptCache(new OpenAITranscriber({ apiKey: process.env["OPENAI_API_KEY"] }), join(recordingsDir, "transcripts")),
      audio: { data: readFileSync(recording), mediaType, filename: `host-voice-note.${ext}` },
      how: `OpenAITranscriber (whisper-1) on ${recording.replace(examplesPath(), "packages/examples")}, cached under recordings/transcripts/`,
    };
  }
  return {
    transcriber: new FakeTranscriber(voiceNote),
    audio: { data: silentWav(1), mediaType: "audio/wav" },
    how: "FakeTranscriber with a scripted transcript — put OPENAI_API_KEY in .env and a host-voice-note.wav in data/ for the live path",
  };
}

export async function run(): Promise<void> {
  const { provider } = demoProvider();
  const { transcriber, audio, how } = pickTranscriber();

  heading("The transcriber is pluggable");
  note(how);
  const known = wavDurationSec(audio.data);
  note(`${audio.data.length} bytes of ${audio.mediaType}; duration from the WAV header: ${known === undefined ? "unknown" : `${known}s`}`);

  heading("audioSource: the transcript as a timestamped source");
  // The transcript cache keys on the audio bytes plus these hints, so both calls below share them.
  const hints = { language: "en", prompt: "Marta, Birch Point Lakehouse, Koivurannantie, Tampere" };
  const source = await audioSource(audio, transcriber, {
    ...hints,
    label: "Host voice note",
    segmentSeconds: 15,
    maxDurationSec: 600,
  });
  show(source.label!, source.text);
  note("segmentSeconds: 15 folds sentence-level segments into blocks; each keeps the start of its first sentence.");

  heading("Extract a Listing, with provenance citing the moment");
  note("Evidence is a verbatim quote of the words; evidenceTimestamp maps it back to the stamped line it came from.");
  const { data, provenance } = await partialCoerceWithProvenance<Listing>(source, {
    provider,
    schema: Listing,
    enumResolver,
    onInvalidField: "drop",
  });
  show("Listing", data);
  table(
    Object.entries(provenance).map(([field, p]) => ({
      field,
      confidence: p.confidence,
      at: evidenceTimestamp(source.text, p.evidence)?.timestamp ?? "",
      evidence: p.evidence ?? "",
    })),
  );
  const located = Object.values(provenance).filter((p) => evidenceTimestamp(source.text, p.evidence)).length;
  if (located > 0) ok(`evidenceTimestamp located ${located} of ${Object.keys(provenance).length} quotes on a stamped line — a review UI can seek the player to each`);
  else warn("no quote could be located on a stamped line this time — the model paraphrased rather than quoted");
  note("Asking the model to keep the stamp on its quotes was tried: it interpolates plausible ones. The line's stamp is the truth.");
  if (data.address?.zip === "34130") ok("the corrected postcode won: sources say to prefer the value stated most explicitly");

  heading("audioSources: a long recording as one source per stretch");
  const parts = await audioSources(audio, transcriber, { ...hints, label: "Voice note", chunkSeconds: 30 });
  note(parts.map((p) => `${p.label}: ${p.text.length} chars`).join("\n"));
  note("Each chunk is its own source, so maxInputChars trims a stretch of a long call rather than its tail, and provenance names the stretch.");
  if (transcriber instanceof FakeTranscriber) {
    note("The fake transcriber answered twice; withTranscriptCache would have made the second call free.");
  } else {
    note("That second transcription was served from recordings/transcripts/ — same bytes, same hints. So was the first, if you have run this before.");
  }
}
