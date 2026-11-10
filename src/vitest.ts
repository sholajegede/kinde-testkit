import { afterAll, beforeAll } from "vitest";
import { getDefaultTestkit, type KindeTestkit, type ScenarioTokenOverrides } from "./testkit.js";
import { startKindeTestkit, type RunningKindeTestkit, type StartKindeTestkitOptions } from "./server.js";
import type { KindePrincipal, Scenario } from "./types.js";

export interface KindeTestAuth {
  token: string | null;
  headers: Record<string, string>;
  principal: KindePrincipal | null;
  request: { headers: Record<string, string> };
}

export async function kindeTest(options: {
  scenario: Scenario;
  testkit?: KindeTestkit;
  token?: ScenarioTokenOverrides;
}): Promise<KindeTestAuth> {
  const testkit = options.testkit ?? (await getDefaultTestkit());
  const token = await testkit.tokenFor(options.scenario, options.token);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return {
    token,
    headers,
    principal: testkit.principalFor(options.scenario),
    request: { headers },
  };
}

export interface KindeTestkitHandle {
  readonly url: string;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly testkit: KindeTestkit;
  auth(scenario: Scenario, token?: ScenarioTokenOverrides): Promise<KindeTestAuth>;
}

export function useKindeTestkit(options: StartKindeTestkitOptions = {}): KindeTestkitHandle {
  let running: RunningKindeTestkit | null = null;

  beforeAll(async () => {
    running = await startKindeTestkit({ port: 0, ...options });
  });
  afterAll(async () => {
    await running?.close();
    running = null;
  });

  const current = (): RunningKindeTestkit => {
    if (!running) throw new Error("useKindeTestkit() is only ready inside tests and hooks, after beforeAll runs.");
    return running;
  };

  return {
    get url() {
      return current().url;
    },
    get issuer() {
      return current().issuer;
    },
    get jwksUri() {
      return current().jwksUri;
    },
    get testkit() {
      return current().testkit;
    },
    auth: (scenario, token) => kindeTest({ scenario, testkit: current().testkit, token }),
  };
}
