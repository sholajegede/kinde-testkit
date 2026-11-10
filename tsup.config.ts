import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    target: "node20",
    sourcemap: true,
  },
  {
    entry: { vitest: "src/vitest.ts" },
    format: ["esm"],
    dts: true,
    target: "node20",
    external: ["vitest"],
    sourcemap: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
