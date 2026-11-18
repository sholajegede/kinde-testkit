import { getDefaultTestkit, type KindeTestkit, type ScenarioTokenOverrides } from "./testkit.js";
import { startKindeTestkit, type RunningKindeTestkit, type StartKindeTestkitOptions } from "./server.js";
import type { ActivityLog } from "./activity.js";
import type { CoverageRecorder } from "./coverage.js";
import type { Directory } from "./directory.js";
import type { FailureInjector } from "./failures.js";
import type { TestkitSeed } from "./seed.js";
import type { WebhookDispatcher } from "./webhooks.js";
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
  readonly failures: FailureInjector;
  readonly webhooks: WebhookDispatcher;
  readonly directory: Directory;
  readonly coverage: CoverageRecorder;
  readonly activity: ActivityLog;
  readonly certificatePath: string | null;
  auth(scenario: Scenario, token?: ScenarioTokenOverrides): Promise<KindeTestAuth>;
  loadSeed(seed: TestkitSeed): void;
  reset(): void;
}

type Hook = (fn: () => Promise<void>, timeout?: number) => void;

/** Starts a testkit before the tests in the file and stops it after them. Shared by the Vitest and Jest helpers. */
export function createKindeTestkitHandle(
  hooks: { beforeAll: Hook; afterAll: Hook },
  options: StartKindeTestkitOptions,
  name: string,
): KindeTestkitHandle {
  let running: RunningKindeTestkit | null = null;

  hooks.beforeAll(async () => {
    running = await startKindeTestkit({ port: 0, ...options });
  });
  hooks.afterAll(async () => {
    await running?.close();
    running = null;
  });

  const current = (): RunningKindeTestkit => {
    if (!running) throw new Error(`${name}() is only ready inside tests and hooks, after beforeAll runs.`);
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
    get failures() {
      return current().failures;
    },
    get webhooks() {
      return current().webhooks;
    },
    get directory() {
      return current().directory;
    },
    get coverage() {
      return current().coverage;
    },
    get activity() {
      return current().activity;
    },
    get certificatePath() {
      return current().certificatePath;
    },
    auth: (scenario, token) => kindeTest({ scenario, testkit: current().testkit, token }),
    loadSeed: (seed) => current().loadSeed(seed),
    reset: () => current().reset(),
  };
}
