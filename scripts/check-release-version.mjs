// Asserts every publishable package sits at the version being released.
// Run from CI with the tag's version (no leading "v").
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const expected = process.argv[2];
if (!expected) {
  console.error("usage: check-release-version.mjs <version>");
  process.exit(1);
}

const mismatches = [];
for (const dir of readdirSync("packages")) {
  const manifest = JSON.parse(readFileSync(join("packages", dir, "package.json"), "utf8"));
  if (manifest.private) continue;
  if (manifest.version !== expected) {
    mismatches.push(`${manifest.name}: ${manifest.version}`);
  }
}

if (mismatches.length > 0) {
  console.error(`Tag is v${expected}, but these packages disagree:`);
  for (const line of mismatches) console.error(`  ${line}`);
  console.error("\nRun `pnpm version:set <version>`, commit, then retag.");
  process.exit(1);
}

console.log(`All publishable packages are at ${expected}.`);
