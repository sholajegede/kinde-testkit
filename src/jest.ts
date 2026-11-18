import { createKindeTestkitHandle, type KindeTestkitHandle } from "./handle.js";
import type { StartKindeTestkitOptions } from "./server.js";

export { kindeTest, type KindeTestAuth, type KindeTestkitHandle } from "./handle.js";

type Hook = (fn: () => Promise<void>, timeout?: number) => void;

/**
 * Starts a testkit for the test file. Use the handle inside tests and hooks.
 * Uses Jest's global beforeAll and afterAll. With injectGlobals: false, pass them in:
 * useKindeTestkit(options, { beforeAll, afterAll }) with the functions from @jest/globals.
 */
export function useKindeTestkit(
  options: StartKindeTestkitOptions = {},
  hooks?: { beforeAll: Hook; afterAll: Hook },
): KindeTestkitHandle {
  const globals = globalThis as unknown as { beforeAll?: Hook; afterAll?: Hook };
  const beforeAll = hooks?.beforeAll ?? globals.beforeAll;
  const afterAll = hooks?.afterAll ?? globals.afterAll;
  if (typeof beforeAll !== "function" || typeof afterAll !== "function") {
    throw new Error(
      "useKindeTestkit() from kinde-testkit/jest needs Jest's beforeAll and afterAll. Call it at the top of a test file, or pass them from @jest/globals.",
    );
  }
  return createKindeTestkitHandle({ beforeAll, afterAll }, options, "useKindeTestkit");
}
