import { describe, expect, it } from "vitest";
import { setupKindeTestkit } from "../src/cypress.js";

describe("setupKindeTestkit", () => {
  it("starts a testkit, tells the commands where it is, and stops it after the run", async () => {
    const handlers: Array<() => Promise<void> | void> = [];
    const config = await setupKindeTestkit((_event, handler) => handlers.push(() => handler({})), { env: {} as Record<string, unknown> }, {
      start: { port: 0, seed: { users: [{ id: "kp_admin", email: "admin@example.test" }] } },
    });
    const url = config.env.KINDE_TESTKIT_URL as string;
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(((await (await fetch(`${url}/testkit/users`)).json()) as unknown[]).length).toBe(1);

    for (const handler of handlers) await handler();
    await expect(fetch(`${url}/testkit/health`)).rejects.toThrow();
  });

  it("points at an issuer you started yourself", async () => {
    const config = await setupKindeTestkit(() => undefined, { env: {} as Record<string, unknown> }, { url: "http://localhost:4500/" });
    expect(config.env.KINDE_TESTKIT_URL).toBe("http://localhost:4500");
  });
});
