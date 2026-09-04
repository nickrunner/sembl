import { defineConfig } from "tsup";

export default defineConfig({
  entry: { run: "src/run.ts", "support/eval-config": "src/support/eval-config.ts" },
  format: ["esm"],
  clean: true,
  sourcemap: true,
});
