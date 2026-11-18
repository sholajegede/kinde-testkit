import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CoverageRecorder,
  formatCoverageReport,
  readCoverageDirectory,
  scenario,
  startKindeTestkit,
  type CoverageReport,
  type TestkitSeed,
} from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [
    { id: "kp_admin", email: "admin@example.test" },
    { id: "kp_viewer", email: "viewer@example.test" },
    { id: "kp_other", email: "other@example.test" },
  ],
  organizations: [{ code: "org_acme" }, { code: "org_globex" }],
  roles: [{ key: "admin", permissions: ["projects:read", "projects:delete"] }],
  memberships: [
    { user: "kp_admin", organization: "org_acme", roles: ["admin"] },
    { user: "kp_admin", organization: "org_globex", permissions: ["projects:read"] },
    { user: "kp_viewer", organization: "org_acme", permissions: ["projects:read"] },
    { user: "kp_other", organization: "org_globex", permissions: ["projects:read"] },
  ],
  applications: [{ clientId: "svc", scopes: ["read:users"], organization: "org_acme" }],
  featureFlags: [{ key: "beta", value: true }],
};

let receiver: Server;
let receiverUrl = "";
beforeAll(async () => {
  receiver = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(req.url === "/refuse" ? 500 : 200).end());
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => receiver.close(resolve)));

const kinde = useKindeTestkit({ seed, webhooks: { retryDelaysMs: [0] } });
beforeEach(() => {
  kinde.reset();
  kinde.coverage.reset();
});

const covered = (report: CoverageReport) =>
  new Set(report.groups.flatMap((g) => g.items.filter((i) => i.covered).map((i) => i.id)));

async function mint(body: Record<string, unknown>) {
  return fetch(`${kinde.url}/testkit/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(email: string, org?: string) {
  const redirectUri = "http://localhost:3000/callback";
  const page = await fetch(`${kinde.url}/oauth2/auth?client_id=app&response_type=code&scope=openid%20offline&redirect_uri=${encodeURIComponent(redirectUri)}`);
  const request = /name="request" value="([^"]+)"/.exec(await page.text())![1]!;
  const form = new URLSearchParams({ request, email });
  if (org) form.set("org", org);
  const login = await fetch(`${kinde.url}/oauth2/auth/login`, { method: "POST", body: form, redirect: "manual" });
  if (login.status !== 303) return login;
  const code = new URL(login.headers.get("location")!).searchParams.get("code")!;
  const tokens = await fetch(`${kinde.url}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: "app", code, redirect_uri: redirectUri }),
  });
  return tokens;
}

describe("authentication coverage", () => {
  it("starts empty", () => {
    expect(kinde.coverage.report()).toMatchObject({ covered: 0, total: 46 });
  });

  it("records identity, organization and permission scenarios from minted tokens", async () => {
    await kinde.auth(scenario().unauthenticated());
    await mint({ user: "admin@example.test", organization: "org_acme" });
    await mint({ user: "admin@example.test", organization: "org_globex" });
    await mint({ user: "viewer@example.test" });
    await mint({ subject: "kp_loose" });
    expect((await mint({ user: "viewer@example.test", organization: "org_globex" })).status).toBe(400);

    const ids = covered(kinde.coverage.report());
    for (const id of [
      "identity.user",
      "identity.anonymous",
      "identity.no-organization",
      "organization.token",
      "organization.two-for-one-user",
      "organization.cross",
      "organization.non-member",
      "permission.granted",
      "permission.different-sets",
      "permission.roles",
      "permission.none",
      "permission.feature-flags",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("records each invalid token kind", async () => {
    for (const invalid of ["expired", "wrong-audience", "unsigned", "missing-organization"]) await mint({ subject: "kp_x", invalid });
    const ids = covered(kinde.coverage.report());
    expect([...ids].filter((id) => id.startsWith("token.")).sort()).toEqual(["token.expired", "token.unsigned", "token.wrong-audience"]);
    expect(ids).toContain("organization.missing");
  });

  it("records sessions, suspended users and silent sign-in", async () => {
    const tokens = (await (await signIn("admin@example.test", "org_acme")).json()) as { refresh_token: string };
    await fetch(`${kinde.url}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: "app", refresh_token: tokens.refresh_token }),
    });
    await fetch(`${kinde.url}/oauth2/revoke`, { method: "POST", body: new URLSearchParams({ token: "x" }) });
    await fetch(`${kinde.url}/logout`);
    await fetch(`${kinde.url}/oauth2/auth?client_id=app&response_type=code&prompt=none&redirect_uri=${encodeURIComponent("http://localhost:3000/cb")}`, { redirect: "manual" });
    await signIn("new.person@example.test");
    const user = kinde.directory.user("kp_viewer")!;
    kinde.directory.meta(user).isSuspended = true;
    expect((await signIn("viewer@example.test")).status).toBe(403);

    const ids = covered(kinde.coverage.report());
    for (const id of ["session.sign-in", "session.refresh", "session.revoke", "session.sign-out", "session.silent", "identity.id-token", "identity.unseeded", "identity.suspended"]) {
      expect(ids, id).toContain(id);
    }
  });

  it("records M2M tokens, Kinde API calls, webhooks and outages", async () => {
    const m2m = await fetch(`${kinde.url}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "svc", audience: `${kinde.issuer}/api` }),
    });
    const { access_token } = (await m2m.json()) as { access_token: string };
    await mint({ m2m: true, invalid: "expired" });
    const api = (method: string, path: string, token = access_token) =>
      fetch(`${kinde.url}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify({ name: "Initech" }) });
    await api("GET", "/users");
    await api("POST", "/organization");
    const full = await (await fetch(`${kinde.url}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: "admin_app", audience: `${kinde.issuer}/api` }),
    })).json() as { access_token: string };
    expect((await api("POST", "/organization", full.access_token)).status).toBe(200);
    const user = (await (await mint({ user: "admin@example.test", organization: "org_acme" })).json()) as { access_token: string };
    await fetch(`${kinde.url}/account_api/v1/permissions`, { headers: { authorization: `Bearer ${user.access_token}` } });

    kinde.webhooks.addEndpoint({ url: `${receiverUrl}/ok` });
    await kinde.webhooks.send({ type: "user.updated", user: "kp_admin", duplicate: 2 });
    await kinde.webhooks.send({ type: "user.updated", user: "kp_admin", invalid: "bad-signature" });
    await kinde.webhooks.send({ type: "user.updated", user: "kp_admin", invalid: "stale" });
    await kinde.webhooks.send({ type: "user.updated", user: "kp_admin", to: `${receiverUrl}/refuse` });

    kinde.failures.add({ path: "/oauth2/token", status: 503, times: 1 });
    kinde.failures.add({ path: "/oauth2/v2/user_profile", status: 429, delayMs: 5, times: 1 });
    kinde.failures.add({ path: "/.well-known/jwks.json", hang: true, times: 1 });
    await fetch(`${kinde.url}/oauth2/token`, { method: "POST" });
    await fetch(`${kinde.url}/oauth2/v2/user_profile`);
    await fetch(`${kinde.url}/.well-known/jwks.json`, { signal: AbortSignal.timeout(100) }).catch(() => undefined);

    const ids = covered(kinde.coverage.report());
    for (const id of [
      "m2m.token",
      "m2m.scopes",
      "m2m.organization",
      "m2m.invalid",
      "api.management-read",
      "api.management-denied",
      "api.management-write",
      "api.account",
      "webhook.delivered",
      "webhook.duplicate",
      "webhook.forged",
      "webhook.stale",
      "webhook.failed",
      "outage.error",
      "outage.rate-limit",
      "outage.slow",
      "outage.timeout",
    ]) {
      expect(ids, id).toContain(id);
    }
  });

  it("keeps coverage across reset(), so beforeEach resets do not lose it", async () => {
    await mint({ user: "admin@example.test", organization: "org_acme" });
    kinde.reset();
    expect(kinde.coverage.report().covered).toBeGreaterThan(0);
  });
});

describe("coverage files", () => {
  it("writes a snapshot when the testkit closes and merges runs from separate files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kinde-coverage-"));
    for (const invalid of ["expired", "unsigned"]) {
      const running = await startKindeTestkit({ port: 0, coverage: { directory } });
      await running.testkit.token({ invalid: invalid as "expired" });
      await running.close();
    }
    expect(readdirSync(directory)).toHaveLength(2);
    const { files, report } = readCoverageDirectory(directory);
    expect(files).toBe(2);
    const ids = covered(report);
    expect(ids).toContain("token.expired");
    expect(ids).toContain("token.unsigned");
  });

  it("formats the report with totals and hints for what is missing", () => {
    const recorder = new CoverageRecorder();
    recorder.hit("session.sign-in");
    const text = formatCoverageReport(recorder.report());
    expect(text).toContain("Kinde authentication coverage");
    expect(text).toMatch(/Sessions\s+1\/5/);
    expect(text).toContain("Overall: 1/46");
    expect(text).toContain("Sessions: Refresh. Let the app refresh its session");
  });
});
