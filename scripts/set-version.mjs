// Sets one version across every publishable package. Versions move in
// lockstep while the project is 0.x, so there is a single number to reason
// about and the tag can be checked against it.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: pnpm version:set <x.y.z[-tag]>");
  process.exit(1);
}

for (const dir of readdirSync("packages")) {
  const path = join("packages", dir, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.private) continue;
  manifest.version = version;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${manifest.name} -> ${version}`);
}

console.log(`\nNext: commit, then \`git tag v${version} && git push --tags\`.`);
