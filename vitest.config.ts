import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Contract tests call a real Kinde business. Run them with npm run test:contract.
    exclude: [...configDefaults.exclude, ...(process.env.KINDE_CONTRACT_DOMAIN ? [] : ["test/contract/**"])],
    testTimeout: 15000,
  },
});
