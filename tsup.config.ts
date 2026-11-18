import { defineConfig, type Options } from "tsup";

// jose ships as ESM only. CommonJS builds bundle it, so require() works in Jest and older tooling.
const commonJs: Options = { format: ["cjs"], noExternal: ["jose"], target: "node20", sourcemap: true, dts: true };

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    clean: true,
    target: "node20",
    sourcemap: true,
  },
  { entry: { index: "src/index.ts" }, ...commonJs },
  {
    entry: { vitest: "src/vitest.ts" },
    format: ["esm"],
    dts: true,
    target: "node20",
    external: ["vitest"],
    sourcemap: true,
  },
  { entry: { jest: "src/jest.ts" }, format: ["esm"], dts: true, target: "node20", sourcemap: true },
  { entry: { jest: "src/jest.ts" }, ...commonJs },
  {
    entry: { playwright: "src/playwright.ts" },
    format: ["esm"],
    dts: true,
    target: "node20",
    external: ["@playwright/test"],
    sourcemap: true,
  },
  { entry: { cypress: "src/cypress.ts" }, format: ["esm"], dts: true, target: "node20", sourcemap: true },
  { entry: { cypress: "src/cypress.ts" }, ...commonJs },
  {
    entry: { "cypress-support": "src/cypress-support.ts" },
    format: ["esm"],
    dts: true,
    target: "es2020",
    platform: "browser",
    sourcemap: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
