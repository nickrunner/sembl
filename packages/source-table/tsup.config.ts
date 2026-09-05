import { defineConfig } from "tsup";

// Dual output: ESM for modern toolchains, CommonJS for services that still
// compile to `require`. tsup emits `.d.ts` beside the ESM build and `.d.cts`
// beside the CommonJS one so each resolution condition gets matching types.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
