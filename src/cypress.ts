import { startKindeTestkit, type RunningKindeTestkit, type StartKindeTestkitOptions } from "./server.js";

export interface SetupKindeTestkitOptions {
  /**
   * Start a testkit inside the Cypress process. Your app must use the same issuer,
   * so keep the default port 4400 or set KINDE_ISSUER_URL to match.
   * Leave this out to use an issuer you started yourself with `kinde-testkit start`.
   */
  start?: StartKindeTestkitOptions;
  /** The issuer to use when you started it yourself. Default: KINDE_ISSUER_URL, then http://localhost:4400. */
  url?: string;
}

interface CypressConfig {
  env: Record<string, unknown>;
}

// Matches the "after:run" overload of Cypress's on(), so Cypress's own on() can be passed in.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type On = (event: "after:run", handler: (results: any) => void | Promise<void>) => void;

/**
 * Call from setupNodeEvents in cypress.config.ts. Starts the testkit when asked and tells the
 * kinde-testkit Cypress commands where it is, through Cypress.env("KINDE_TESTKIT_URL").
 */
export async function setupKindeTestkit<C extends CypressConfig>(
  on: On,
  config: C,
  options: SetupKindeTestkitOptions = {},
): Promise<C> {
  let url = options.url ?? (config.env.KINDE_TESTKIT_URL as string | undefined) ?? process.env.KINDE_ISSUER_URL ?? "http://localhost:4400";
  let running: RunningKindeTestkit | null = null;
  if (options.start) {
    running = await startKindeTestkit({ port: 4400, ...options.start });
    url = running.url;
    on("after:run", async () => {
      await running?.close();
      running = null;
    });
  }
  config.env.KINDE_TESTKIT_URL = url.replace(/\/+$/, "");
  return config;
}
