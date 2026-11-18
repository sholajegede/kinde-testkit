import { afterAll, beforeAll } from "vitest";
import { createKindeTestkitHandle, type KindeTestkitHandle } from "./handle.js";
import type { StartKindeTestkitOptions } from "./server.js";

export { kindeTest, type KindeTestAuth, type KindeTestkitHandle } from "./handle.js";

/** Starts a testkit for the test file. Use the handle inside tests and hooks. */
export function useKindeTestkit(options: StartKindeTestkitOptions = {}): KindeTestkitHandle {
  return createKindeTestkitHandle({ beforeAll, afterAll }, options, "useKindeTestkit");
}
