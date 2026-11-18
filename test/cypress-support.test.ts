import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startKindeTestkit, type RunningKindeTestkit } from "../src/index.js";

// A stand-in for Cypress: cy.request and cy.visit run real HTTP requests, chained like Cypress commands.
class Chain<T = unknown> {
  constructor(readonly promise: Promise<T>) {}
  then<R>(fn: (value: T) => R): Chain<unknown> {
    return new Chain(this.promise.then((value) => {
      const result = fn(value);
      return result instanceof Chain ? result.promise : result;
    }));
  }
}

const visited: string[] = [];
const commands = new Map<string, (...args: unknown[]) => Chain>();
let afterEachHook: (() => unknown) | undefined;
const env: Record<string, unknown> = {};

async function request(options: { method?: string; url: string; body?: unknown; form?: boolean; followRedirect?: boolean; failOnStatusCode?: boolean }) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.body !== undefined) {
    if (options.form) {
      body = new URLSearchParams(options.body as Record<string, string>).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
  }
  const response = await fetch(options.url, { method: options.method ?? "GET", headers, body, redirect: options.followRedirect === false ? "manual" : "follow" });
  const text = await response.text();
  const parsed = (response.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : text;
  if (response.status >= 400 && options.failOnStatusCode !== false) throw new Error(`cy.request failed with ${response.status}`);
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) };
}

const cy = {
  request: (options: Parameters<typeof request>[0]) => new Chain(request(options)),
  visit: (url: string) =>
    new Chain(
      fetch(url).then(async (response) => {
        visited.push(url);
        return response.text();
      }),
    ),
  wrap: <T>(value: T) => new Chain(Promise.resolve(value)),
  url: () => new Chain(Promise.resolve(visited.at(-1) ?? "")),
};

Object.assign(globalThis, {
  cy,
  Cypress: {
    env: (name: string) => env[name],
    config: (name: string) => (name === "baseUrl" ? appUrl : undefined),
    Commands: { add: (name: string, fn: (...args: unknown[]) => Chain) => commands.set(name, fn) },
    log: () => undefined,
  },
  afterEach: (fn: () => unknown) => (afterEachHook = fn),
});

let testkit: RunningKindeTestkit;
let app: Server;
let appUrl = "";
const sessions: string[] = [];

const run = <T>(name: string, ...args: unknown[]) => (commands.get(name)!(...args) as Chain<T>).promise;

beforeAll(async () => {
  testkit = await startKindeTestkit({
    port: 0,
    seed: {
      users: [
        { id: "kp_admin", email: "admin@example.test" },
        { id: "kp_consultant", email: "consultant@example.test" },
      ],
      organizations: [{ code: "org_acme" }, { code: "org_globex" }],
      memberships: [
        { user: "kp_admin", organization: "org_acme", permissions: ["projects:delete"] },
        { user: "kp_consultant", organization: "org_acme" },
        { user: "kp_consultant", organization: "org_globex" },
      ],
    },
  });
  // A small app with an SDK-style login route and callback.
  app = createServer(async (req, res) => {
    const url = new URL(req.url!, appUrl);
    if (url.pathname === "/api/auth/login") {
      const target = new URL(`${testkit.url}/oauth2/auth`);
      target.search = new URLSearchParams({ client_id: "app", response_type: "code", redirect_uri: `${appUrl}/api/auth/kinde_callback`, state: "s1" }).toString();
      for (const name of ["login_hint", "org_code"]) if (url.searchParams.has(name)) target.searchParams.set(name, url.searchParams.get(name)!);
      res.writeHead(307, { location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/api/auth/kinde_callback" && url.searchParams.has("error")) {
      res.writeHead(400).end(`sign-in failed: ${url.searchParams.get("error")}`);
      return;
    }
    if (url.pathname === "/api/auth/kinde_callback") {
      const tokens = await fetch(`${testkit.url}/oauth2/token`, {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: "app", code: url.searchParams.get("code")!, redirect_uri: `${appUrl}/api/auth/kinde_callback` }),
      }).then((r) => r.json() as Promise<{ access_token: string }>);
      const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1]!, "base64url").toString()) as { sub: string; org_code: string };
      sessions.push(`${claims.sub}@${claims.org_code}`);
      res.writeHead(200).end("signed in");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  env.KINDE_TESTKIT_URL = testkit.url;
  await import("../src/cypress-support.js");
});

afterAll(async () => {
  await testkit.close();
  await new Promise((resolve) => app.close(resolve));
});

beforeEach(() => {
  sessions.length = 0;
  testkit.reset();
});

describe("kinde-testkit/cypress/support", () => {
  it("registers the commands", () => {
    expect([...commands.keys()].sort()).toEqual(
      ["kindeAuthenticateAs", "kindeClearFailures", "kindeInjectFailure", "kindeReset", "kindeSendWebhook", "kindeSignIn", "kindeSignOut", "kindeToken"].sort(),
    );
  });

  it("signs a user in through the app's login route without the sign-in page", async () => {
    await run("kindeSignIn", "admin@example.test");
    expect(sessions).toEqual(["kp_admin@org_acme"]);
    expect(visited.at(-1)).toMatch(/\/api\/auth\/kinde_callback\?code=/);
  });

  it("signs in to a chosen organization, and explains a missing choice", async () => {
    await run("kindeSignIn", "consultant@example.test", { org: "org_globex" });
    expect(sessions).toEqual(["kp_consultant@org_globex"]);
    await expect(run("kindeSignIn", "consultant@example.test")).rejects.toThrow("belongs to more than one organization");
  });

  it("signs in as an inline identity that is not in the seed", async () => {
    await run("kindeAuthenticateAs", { email: "auditor@example.test", organization: "org_acme", permissions: ["projects:read"] });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^kp_[0-9a-f]+@org_acme$/);
  });

  it("signs in with a social connection and MFA, and lets failing outcomes through", async () => {
    await run("kindeSignIn", "admin@example.test", { connection: "google", mfa: "passed" });
    expect(sessions).toEqual(["kp_admin@org_acme"]);
    await run("kindeSignIn", "admin@example.test", { mfa: "failed" });
    await run("kindeSignIn", "admin@example.test", { connection: "github", providerResult: "cancelled" });
    expect(sessions).toHaveLength(1);
    expect(new URL(visited.at(-1)!).searchParams.get("error")).toBe("access_denied");
  });

  it("explains a refused sign-in", async () => {
    await expect(run("kindeSignIn", "admin@example.test", { org: "org_globex" })).rejects.toThrow(
      "kinde-testkit refused the sign-in: admin@example.test is not a member of org_globex.",
    );
  });

  it("mints tokens and sends webhooks", async () => {
    const token = await run<string>("kindeToken", { user: "admin@example.test" });
    expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString())).toMatchObject({ sub: "kp_admin" });
    await expect(run("kindeSendWebhook", { type: "user.created", user: "kp_admin" })).rejects.toThrow("No webhook endpoint listens for user.created");
  });

  it("removes injected failures after each test", async () => {
    await run("kindeInjectFailure", { path: "/oauth2/token", status: 503 });
    expect(testkit.failures.list()).toHaveLength(1);
    await (afterEachHook!() as Chain).promise;
    expect(testkit.failures.list()).toEqual([]);
  });
});
