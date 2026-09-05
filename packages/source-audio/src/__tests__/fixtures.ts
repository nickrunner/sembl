import type { Transcript } from "../transcriber.js";

/**
 * A minimal PCM WAV: a RIFF header, a `fmt ` chunk and a `data` chunk of
 * silence. Enough for the header reader; nothing decodes it.
 */
export function silentWav(seconds: number, sampleRate = 8000, channels = 1, bits = 16): Uint8Array {
  const blockAlign = (channels * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = Math.round(seconds * byteRate);
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

/** A short two-speaker transcript with segments. */
export const scripted: Transcript = {
  text: "Hi, it's Marta about the lakehouse. It sleeps eight. Two forty a night in euros. Great, thanks.",
  language: "en",
  durationSec: 95,
  segments: [
    { start: 0, end: 4.5, text: "Hi, it's Marta about the lakehouse.", speaker: "Host" },
    { start: 4.5, end: 9, text: "It sleeps eight.", speaker: "Host" },
    { start: 75, end: 80, text: "Two forty a night in euros.", speaker: "Host" },
    { start: 88, end: 92, text: "Great, thanks.", speaker: "Agent" },
  ],
};
