import { describe, it, expect } from "vitest";
import { isWav, wavDurationSec } from "../index.js";
import { silentWav } from "./fixtures.js";

describe("wavDurationSec", () => {
  it("reads the duration from the fmt and data chunks", () => {
    expect(wavDurationSec(silentWav(1.5))).toBe(1.5);
    expect(wavDurationSec(silentWav(3, 44100, 2, 16))).toBe(3);
    expect(wavDurationSec(silentWav(0.25, 16000, 1, 8))).toBe(0.25);
  });

  it("skips chunks it does not know, with odd sizes padded", () => {
    const wav = silentWav(1);
    const list = new Uint8Array(8 + 5 + 1);
    list.set([0x4c, 0x49, 0x53, 0x54]); // LIST
    new DataView(list.buffer).setUint32(4, 5, true); // odd size → pad byte
    const spliced = new Uint8Array(12 + list.length + wav.length - 12);
    spliced.set(wav.subarray(0, 12));
    spliced.set(list, 12);
    spliced.set(wav.subarray(12), 12 + list.length);
    expect(wavDurationSec(spliced)).toBe(1);
  });

  it("measures a streaming WAV by the bytes present", () => {
    const wav = silentWav(2);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    expect(wavDurationSec(wav)).toBe(2);
    expect(wavDurationSec(wav.subarray(0, 44 + 8000))).toBe(0.5);
  });

  it("is undefined for anything that is not a well-formed WAV", () => {
    expect(wavDurationSec(new Uint8Array([0x49, 0x44, 0x33]))).toBeUndefined();
    expect(wavDurationSec(new Uint8Array())).toBeUndefined();
    expect(wavDurationSec(silentWav(1).subarray(0, 30))).toBeUndefined();
    const zeroRate = silentWav(1);
    new DataView(zeroRate.buffer).setUint32(28, 0, true);
    expect(wavDurationSec(zeroRate)).toBeUndefined();
  });

  it("recognises the container by its magic", () => {
    expect(isWav(silentWav(0.1))).toBe(true);
    expect(isWav(new Uint8Array(20))).toBe(false);
  });
});
