import { defineConfig, devices } from "@playwright/test";
import type { KindeTestOptions } from "kinde-testkit/playwright";

const ISSUER = "http://localhost:4400";
const APP = "http://localhost:3000";

export default defineConfig<KindeTestOptions>({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    baseURL: APP,
    kindeIssuer: ISSUER,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
    },
  ],
  webServer: [
    {
      command: "npx kinde-testkit start --port 4400",
      url: `${ISSUER}/testkit/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev",
      url: APP,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        KINDE_ISSUER_URL: ISSUER,
        KINDE_CLIENT_ID: "kinde_testkit_example",
        KINDE_CLIENT_SECRET: "testkitexampleclientsecret0000000000000000",
        KINDE_SITE_URL: APP,
        KINDE_POST_LOGIN_REDIRECT_URL: APP,
        KINDE_POST_LOGOUT_REDIRECT_URL: APP,
      },
    },
  ],
});
