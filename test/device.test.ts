import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { startKindeTestkit, type TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [{ id: "kp_admin", email: "admin@example.test" }],
  organizations: [{ code: "org_acme" }],
  memberships: [{ user: "kp_admin", organization: "org_acme", roles: ["admin"], permissions: ["projects:read"] }],
  applications: [
    { clientId: "cli_app", audience: ["https://api.example.test"] },
    { clientId: "worker", clientSecret: "worker_secret", audience: "https://api.example.test" },
  ],
};

const kinde = useKindeTestkit({ seed, device: { intervalSeconds: 0 } });

const form = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(body),
});

async function post(path: string, body: Record<string, string>, headers?: Record<string, string>) {
  const response = await fetch(`${kinde.url}${path}`, form(body, headers));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const startDevice = (extra: Record<string, string> = {}) => post("/oauth2/device/auth", { client_id: "cli_app", ...extra });
const poll = (deviceCode: string) =>
  post("/oauth2/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "cli_app", device_code: deviceCode });

async function control(body: Record<string, unknown>) {
  const response = await fetch(`${kinde.url}/testkit/device`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeEach(() => kinde.reset());

describe("discovery", () => {
  it("lists the endpoints a Kinde business publishes", async () => {
    const doc = (await (await fetch(`${kinde.url}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      device_authorization_endpoint: `${kinde.issuer}/oauth2/device/auth`,
      introspection_endpoint: `${kinde.issuer}/oauth2/introspect`,
      registration_endpoint: `${kinde.issuer}/oauth2/register`,
      grant_types_supported: expect.arrayContaining(["client_credentials", "urn:ietf:params:oauth:grant-type:device_code"]),
    });
  });
});

describe("device authorization flow", () => {
  it("returns Kinde's device response", async () => {
    const { status, body } = await startDevice({ audience: "https://api.example.test" });
    expect(status).toBe(200);
    expect(body).toEqual({
      device_code: expect.stringMatching(/^kinde_dc_/),
      user_code: expect.stringMatching(/^[A-Z]{8}$/),
      verification_uri: `${kinde.issuer}/device`,
      verification_uri_complete: `${kinde.issuer}/device?user_code=${body.user_code}`,
      expires_in: 600,
      interval: 0,
    });
  });

  it("answers authorization_pending, then issues a token once a seeded user approves", async () => {
    const { body: device } = await startDevice({ audience: "https://api.example.test" });
    expect((await poll(device.device_code)).body.error).toBe("authorization_pending");

    expect((await control({ user_code: device.user_code, user: "admin@example.test", organization: "org_acme" })).status).toBe(200);
    const { status, body } = await poll(device.device_code);
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "bearer", expires_in: 86400 });
    expect(decodeJwt(body.access_token)).toMatchObject({ sub: "kp_admin", org_code: "org_acme", azp: "cli_app", aud: ["https://api.example.test"], permissions: ["projects:read"] });
    expect((await poll(device.device_code)).body.error).toBe("invalid_grant");
  });

  it("answers access_denied when the user denies the device", async () => {
    const { body: device } = await startDevice();
    await control({ user_code: device.user_code, action: "deny" });
    expect(await poll(device.device_code)).toMatchObject({ status: 400, body: { error: "access_denied" } });
  });

  it("answers slow_down when the device polls faster than the interval", async () => {
    const running = await startKindeTestkit({ port: 0, seed });
    try {
      const started = await fetch(`${running.url}/oauth2/device/auth`, form({ client_id: "cli_app" }));
      const device = (await started.json()) as { device_code: string; interval: number };
      expect(device.interval).toBe(5);
      const pollOnce = async () =>
        (await (await fetch(`${running.url}/oauth2/token`, form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "cli_app", device_code: device.device_code }))).json()) as { error: string };
      expect((await pollOnce()).error).toBe("authorization_pending");
      expect((await pollOnce()).error).toBe("slow_down");
    } finally {
      await running.close();
    }
  });

  it("answers expired_token once the code expires", async () => {
    const running = await startKindeTestkit({ port: 0, seed, device: { intervalSeconds: 0, expiresInSeconds: 0 } });
    try {
      const device = (await (await fetch(`${running.url}/oauth2/device/auth`, form({ client_id: "cli_app" }))).json()) as { device_code: string };
      const result = await fetch(`${running.url}/oauth2/token`, form({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "cli_app", device_code: device.device_code }));
      expect(((await result.json()) as { error: string }).error).toBe("expired_token");
    } finally {
      await running.close();
    }
  });

  it("signs in through the /device page and the normal sign-in page", async () => {
    const { body: device } = await startDevice();
    const confirm = await fetch(device.verification_uri_complete);
    expect(await confirm.text()).toContain(device.user_code);

    const signIn = await (await fetch(`${kinde.url}/device/sign-in?user_code=${device.user_code}`)).text();
    const request = /name="request" value="([^"]+)"/.exec(signIn)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const login = await fetch(`${kinde.url}/oauth2/auth/login`, {
      ...form({ request, email: "admin@example.test" }),
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const complete = await fetch(login.headers.get("location")!);
    expect(await complete.text()).toContain("Device connected");

    const { body } = await poll(device.device_code);
    expect(decodeJwt(body.access_token)).toMatchObject({ sub: "kp_admin", org_code: "org_acme" });
  });

  it("refuses an unknown user code on the /device page", async () => {
    const page = await fetch(`${kinde.url}/device?user_code=NOPENOPE`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("unknown, expired or already used");
  });
});

describe("audiences a seeded app may request", () => {
  it("refuses an audience the app does not list, with Kinde's error", async () => {
    const refused = await post("/oauth2/token", { grant_type: "client_credentials", client_id: "worker", client_secret: "worker_secret", audience: `${kinde.issuer}/api` });
    expect(refused).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(refused.body.error_description).toContain(`Requested audience '${kinde.issuer}/api' has not been whitelisted by the OAuth 2.0 Client.`);
    expect((await startDevice({ audience: "https://other.example.test" })).body.error).toBe("invalid_request");
    const allowed = await post("/oauth2/token", { grant_type: "client_credentials", client_id: "worker", client_secret: "worker_secret", audience: "https://api.example.test" });
    expect(allowed.status).toBe(200);
  });

  it("lets an app that is not seeded request any audience", async () => {
    expect((await post("/oauth2/token", { grant_type: "client_credentials", client_id: "anything", audience: `${kinde.issuer}/api` })).status).toBe(200);
  });
});

describe("token introspection", () => {
  it("needs a Bearer token that differs from the token it checks, as Kinde does", async () => {
    const token = await kinde.testkit.m2mToken({ clientId: "svc" });
    expect(await post("/oauth2/introspect", { token })).toMatchObject({ status: 401, body: { error: "request_unauthorized", error_description: expect.stringContaining("Authorization header missing") } });
    expect(await post("/oauth2/introspect", { token }, { authorization: `Bearer ${token}` })).toMatchObject({ status: 401, body: { error_description: expect.stringContaining("identical") } });
  });

  it("reports active and inactive tokens", async () => {
    const caller = await kinde.testkit.m2mToken({ clientId: "resource_server" });
    const token = await kinde.testkit.m2mToken({ clientId: "svc", audience: ["https://api.example.test"] });
    const active = await post("/oauth2/introspect", { token }, { authorization: `Bearer ${caller}` });
    expect(active.body).toEqual({ active: true, aud: ["https://api.example.test"], client_id: "svc", exp: expect.any(Number), iat: expect.any(Number) });
    const expired = await kinde.testkit.m2mToken({ clientId: "svc", invalid: "expired" });
    expect((await post("/oauth2/introspect", { token: expired }, { authorization: `Bearer ${caller}` })).body).toEqual({ active: false });
  });
});

describe("dynamic client registration", () => {
  it("registers a public client with redirect URIs", async () => {
    const response = await fetch(`${kinde.url}/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "MCP connector", redirect_uris: ["http://localhost:6274/oauth/callback"] }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      client_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      client_name: "MCP connector",
      redirect_uris: ["http://localhost:6274/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("refuses a registration without redirect URIs, with Kinde's error", async () => {
    const response = await fetch(`${kinde.url}/oauth2/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_redirect_uri", error_description: "Redirect URI is not allowed for MCP connector registration" });
  });
});
