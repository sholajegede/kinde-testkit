import { defineConfig } from "cypress";
import { setupKindeTestkit } from "kinde-testkit/cypress";

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    // Run one spec file at a time: failure rules apply to the whole issuer.
    setupNodeEvents(on, config) {
      // Starts kinde-testkit on port 4400 with this example's users, and writes coverage when the run ends.
      return setupKindeTestkit(on, config, { start: { seed: "kinde-testkit.json", coverage: true } });
    },
  },
});
