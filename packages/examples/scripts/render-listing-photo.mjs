#!/usr/bin/env node
/**
 * Renders `data/listing-photo.png`: a sign for the Sea Cabin listing, drawn
 * with a 5×7 bitmap font into an RGB PNG. No dependencies — the PNG encoder
 * is the four chunks the format needs and Node's zlib — so the fixture for
 * example 14 is reproducible from source rather than a binary of unknown
 * origin.
 *
 *   node scripts/render-listing-photo.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LINES = [
  "SEA CABIN",
  "SLEEPS 6",
  "$250 / NIGHT",
  "SAUNA . HOT TUB . WIFI",
  "PETS WELCOME",
  "41 DRIFTWOOD LANE",
  "YACHATS, OR 97498",
];

// 5 columns × 7 rows per glyph, '#' for ink.
const FONT = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  0: [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  1: ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  2: [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  3: ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  4: ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  5: ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  6: ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  7: ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  8: [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  9: [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  $: ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

const SCALE = 5;
const GLYPH_W = 5;
const GLYPH_H = 7;
const GAP = 1; // columns between glyphs, in glyph units
const LEADING = 4; // rows between lines, in glyph units
const PADDING = 6; // in glyph units

const BACKGROUND = [246, 240, 226]; // warm paper
const INK = [38, 44, 52];
const HEADLINE = [156, 46, 32];

const widest = Math.max(...LINES.map((l) => l.length));
const width = (PADDING * 2 + widest * (GLYPH_W + GAP) - GAP) * SCALE;
const height = (PADDING * 2 + LINES.length * (GLYPH_H + LEADING) - LEADING) * SCALE;

const pixels = Buffer.alloc(width * height * 3);
for (let i = 0; i < width * height; i++) pixels.set(BACKGROUND, i * 3);

function plot(gx, gy, rgb) {
  for (let dy = 0; dy < SCALE; dy++) {
    for (let dx = 0; dx < SCALE; dx++) {
      const x = gx * SCALE + dx;
      const y = gy * SCALE + dy;
      pixels.set(rgb, (y * width + x) * 3);
    }
  }
}

LINES.forEach((line, row) => {
  const top = PADDING + row * (GLYPH_H + LEADING);
  const colour = row === 0 ? HEADLINE : INK;
  [...line].forEach((ch, col) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`No glyph for "${ch}"`);
    const left = PADDING + col * (GLYPH_W + GAP);
    glyph.forEach((bits, y) => {
      [...bits].forEach((bit, x) => {
        if (bit === "#") plot(left + x, top + y, colour);
      });
    });
  });
});

// A thin frame, so it reads as a sign rather than a text dump.
for (let x = 0; x < width; x++) for (const y of [0, 1, height - 2, height - 1]) pixels.set(INK, (y * width + x) * 3);
for (let y = 0; y < height; y++) for (const x of [0, 1, width - 2, width - 1]) pixels.set(INK, (y * width + x) * 3);

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8; // bit depth
header[9] = 2; // colour type: RGB
header[10] = 0; // compression
header[11] = 0; // filter
header[12] = 0; // interlace

// One filter byte (0 = none) in front of every scanline.
const raw = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) {
  raw[y * (width * 3 + 1)] = 0;
  pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data", "listing-photo.png");
writeFileSync(out, png);
console.log(`wrote ${out}: ${width}×${height}, ${png.length} bytes`);
