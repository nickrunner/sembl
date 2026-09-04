import { defineConfig } from "tsup";

// Both configs write under dist/, and tsup runs them concurrently, so neither
// may own `clean`; the build script wipes dist/ before tsup starts.

export default defineConfig([
  // The library entry ships dual ESM + CommonJS like the other packages.
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
  },
  // The CLI is only ever run by Node directly, so it stays ESM-only.
  {
    entry: ["src/cli/index.ts"],
    outDir: "dist/cli",
    format: ["esm"],
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
