import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The package directory, found by walking up from wherever this file ended
 * up — `src/support/` when run from source, `dist/` once bundled.
 */
function packageRoot(): string {
  let dir = import.meta.dirname;
  while (!existsSync(resolve(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not find the examples package root");
    dir = parent;
  }
  return dir;
}

/**
 * Load `packages/examples/.env` if there is one. Node has had this built in
 * since 20.12, so the examples take no dotenv dependency.
 */
export function loadEnv(): void {
  const file = resolve(packageRoot(), ".env");
  const load = (process as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (existsSync(file) && typeof load === "function") {
    try {
      load.call(process, file);
    } catch {
      // A malformed .env is not worth failing a demo over.
    }
  }
}

/** Absolute path of a file under `packages/examples/`. */
export function examplesPath(...parts: string[]): string {
  return resolve(packageRoot(), ...parts);
}
