import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/demo.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
});
