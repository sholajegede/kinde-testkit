import { defineConfig } from "tsup";

// Node entry points build together, so they share one copy of the issuer in common chunks.
const node = {
  index: "src/index.ts",
  vitest: "src/vitest.ts",
  jest: "src/jest.ts",
  playwright: "src/playwright.ts",
  cypress: "src/cypress.ts",
  react: "src/react.ts",
  cli: "src/cli.ts",
};

export default defineConfig([
  {
    entry: node,
    format: ["esm"],
    dts: { entry: { index: node.index, vitest: node.vitest, jest: node.jest, playwright: node.playwright, cypress: node.cypress, react: node.react } },
    target: "node20",
    sourcemap: true,
    splitting: true,
    external: ["vitest", "@playwright/test", "cypress", "react", "@kinde-oss/kinde-auth-react", "@kinde/js-utils"],
  },
  // jose ships as ESM only. CommonJS builds bundle it, so require() works in Jest and older tooling.
  {
    entry: { index: node.index, jest: node.jest, cypress: node.cypress },
    format: ["cjs"],
    dts: true,
    target: "node20",
    // The output is not minified, so stack traces stay readable without source maps.
    sourcemap: false,
    // tsup's CommonJS code splitting emits invalid code, so each CommonJS entry is a full bundle.
    splitting: false,
    noExternal: ["jose"],
    external: ["cypress"],
  },
  // Runs in the browser inside Cypress.
  {
    entry: { "cypress-support": "src/cypress-support.ts" },
    format: ["esm"],
    dts: true,
    target: "es2020",
    platform: "browser",
    sourcemap: true,
  },
]);
