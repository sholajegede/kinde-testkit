import { describe, expect, it } from "vitest";
import { FailureInjector } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const kinde = useKindeTestkit();

const token = () =>
  fetch(`${kinde.url}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "svc" }),
  });

describe("failure injection", () => {
  it("answers with the chosen status for the next n requests, then recovers", async () => {
    kinde.failures.add({ path: "/oauth2/token", status: 503, times: 2, retryAfter: 5 });
    const first = await token();
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("5");
    expect(await first.json()).toMatchObject({ error: "temporarily_unavailable" });
    expect((await token()).status).toBe(503);
    expect((await token()).status).toBe(200);
    expect(kinde.failures.list()).toEqual([]);
  });

  it("matches a path prefix and a method", async () => {
    kinde.failures.add({ path: "/.well-known/*", method: "GET", status: 500 });
    expect((await fetch(`${kinde.url}/.well-known/jwks.json`)).status).toBe(500);
    expect((await fetch(`${kinde.url}/.well-known/openid-configuration`)).status).toBe(500);
    kinde.failures.clear();
    expect((await fetch(`${kinde.url}/.well-known/jwks.json`)).status).toBe(200);
  });

  it("adds Retry-After to 429 responses", async () => {
    kinde.failures.add({ path: "/oauth2/token", status: 429, times: 1 });
    const response = await token();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
  });

  it("delays a response", async () => {
    kinde.failures.add({ path: "/.well-known/jwks.json", delayMs: 300, times: 1 });
    const started = Date.now();
    const response = await fetch(`${kinde.url}/.well-known/jwks.json`);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it("hangs until the client gives up", async () => {
    kinde.failures.add({ path: "/oauth2/token", hang: true, times: 1 });
    await expect(
      fetch(`${kinde.url}/oauth2/token`, { method: "POST", signal: AbortSignal.timeout(300) }),
    ).rejects.toThrow();
  });

  it("is controlled over HTTP, which is how separate processes use it", async () => {
    const created = await fetch(`${kinde.url}/testkit/failures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/oauth2/token", status: 500 }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await token()).status).toBe(500);
    expect((await fetch(`${kinde.url}/testkit/failures/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await token()).status).toBe(200);
  });

  it("never blocks the testkit's own control endpoints", async () => {
    const response = await fetch(`${kinde.url}/testkit/failures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/testkit/health", status: 500 }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects rules that do nothing or are out of range", () => {
    const injector = new FailureInjector();
    expect(() => injector.add({ path: "/oauth2/token" })).toThrow(/status/);
    expect(() => injector.add({ path: "oauth2/token", status: 500 })).toThrow(/path/);
    expect(() => injector.add({ path: "/oauth2/token", status: 200 })).toThrow(/400 and 599/);
    expect(() => injector.add({ path: "/oauth2/token", status: 500, times: 0 })).toThrow(/times/);
  });

  it("answers with a malformed body", async () => {
    const jwks = () => fetch(`${kinde.url}/.well-known/jwks.json`);
    kinde.failures.add({ path: "/.well-known/jwks.json", malformed: "invalid-json", times: 1 });
    const broken = await jwks();
    expect(broken.status).toBe(200);
    await expect(broken.json()).rejects.toThrow();

    kinde.failures.add({ path: "/.well-known/jwks.json", malformed: "html", status: 502, times: 1 });
    const html = await jwks();
    expect([html.status, html.headers.get("content-type")]).toEqual([502, "text/html; charset=utf-8"]);

    kinde.failures.add({ path: "/.well-known/jwks.json", malformed: "empty", times: 1 });
    expect(await (await jwks()).text()).toBe("");

    kinde.failures.add({ path: "/.well-known/jwks.json", malformed: "unexpected-json", times: 1 });
    expect(await (await jwks()).json()).not.toHaveProperty("keys");

    expect(((await (await jwks()).json()) as { keys: unknown[] }).keys).toHaveLength(1);
    expect(() => new FailureInjector().add({ path: "/oauth2/token", malformed: "garbage" as never })).toThrow(/malformed/);
  });

  it("reset clears sessions and failure rules", async () => {
    kinde.failures.add({ path: "/oauth2/token", status: 500 });
    expect((await fetch(`${kinde.url}/testkit/reset`, { method: "POST" })).status).toBe(200);
    expect(kinde.failures.list()).toEqual([]);
    expect((await token()).status).toBe(200);
  });
});
