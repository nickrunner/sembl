/**
 * Read the duration of a WAV file from its header.
 *
 * WAV is the one common container where the length is arithmetic on two
 * header fields rather than a decode, so it is the one this package reads.
 * Anything not a well-formed RIFF/WAVE with a `fmt ` and a `data` chunk —
 * an MP3, a truncated header, a zero byte rate — yields `undefined`; the
 * caller treats an unknown duration as unknown, never as zero.
 *
 * A streaming WAV whose `data` size is unset (`0xffffffff`) or overstated
 * is measured against the bytes actually present.
 */
export function wavDurationSec(data: Uint8Array): number | undefined {
  if (data.length < 12 || !tag(data, 0, "RIFF") || !tag(data, 8, "WAVE")) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let byteRate: number | undefined;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (tag(data, offset, "fmt ")) {
      if (body + 16 > data.length) return undefined;
      byteRate = view.getUint32(body + 8, true);
    } else if (tag(data, offset, "data")) {
      if (!byteRate) return undefined;
      const available = data.length - body;
      const bytes = size === 0xffffffff || size > available ? available : size;
      return bytes / byteRate;
    }
    // Chunks are word-aligned: an odd size carries one pad byte.
    offset = body + size + (size % 2);
  }
  return undefined;
}

/** Whether the bytes look like a WAV file, whatever the declared media type says. */
export function isWav(data: Uint8Array): boolean {
  return data.length >= 12 && tag(data, 0, "RIFF") && tag(data, 8, "WAVE");
}

function tag(data: Uint8Array, at: number, expected: string): boolean {
  for (let i = 0; i < expected.length; i++) {
    if (data[at + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}
