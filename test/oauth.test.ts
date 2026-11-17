import { createHash } from "node:crypto";
import { validateToken } from "@kinde/jwt-validator";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import type { TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [
    { id: "kp_admin", email: "admin@example.test", givenName: "Ada", familyName: "Okafor" },
    { id: "kp_consultant", email: "consultant@example.test" },
  ],
  organizations: [
    { code: "org_acme", name: "Acme Inc." },
    { code: "org_globex", name: "Globex" },
  ],
  memberships: [
    { user: "kp_admin", organization: "org_acme", roles: ["admin"], permissions: ["projects:read", "projects:delete"] },
    { user: "kp_consultant", organization: "org_acme", roles: ["viewer"], permissions: ["projects:read"] },
    { user: "kp_consultant", organization: "org_globex", roles: ["admin"], permissions: ["projects:delete"] },
  ],
};

const kinde = useKindeTestkit({ seed });
const CLIENT_ID = "app_client";
const REDIRECT_URI = "http://localhost:3000/api/auth/kinde_callback";

function authorizeUrl(params: Record<string, string> = {}): string {
  const url = new URL(`${kinde.url}/oauth2/auth`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email offline",
    state: "state-123",
    ...params,
  }).toString();
  return url.toString();
}

async function openSignIn(params: Record<string, string> = {}) {
  const response = await fetch(authorizeUrl(params));
  const html = await response.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: response.status, html, request };
}

async function submit(form: Record<string, string>) {
  return fetch(`${kinde.url}/oauth2/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
    redirect: "manual",
  });
}

async function signIn(email: string, params: Record<string, string> = {}, extra: Record<string, string> = {}) {
  const { request } = await openSignIn(params);
  const response = await submit({ request, email, ...extra });
  const location = new URL(response.headers.get("location") ?? "http://invalid/");
  return { response, location, code: location.searchParams.get("code") ?? "" };
}

async function exchange(body: Record<string, string>) {
  const response = await fetch(`${kinde.url}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string | number> };
}

const codeGrant = (code: string) => ({
  grant_type: "authorization_code",
  client_id: CLIENT_ID,
  client_secret: "anything",
  redirect_uri: REDIRECT_URI,
  code,
});

describe("sign-in page", () => {
  it("lists seeded users and fills in login_hint", async () => {
    const { status, html } = await openSignIn({ login_hint: "admin@example.test" });
    expect(status).toBe(200);
    expect(html).toContain('value="admin@example.test" placeholder');
    expect(html).toContain("consultant@example.test");
    expect(html).toContain("2 organizations");
  });

  it("refuses a request without a usable redirect_uri", async () => {
    const response = await fetch(authorizeUrl({ redirect_uri: "javascript:alert(1)" }));
    expect(response.status).toBe(400);
  });

  it("answers prompt=none with login_required", async () => {
    const response = await fetch(authorizeUrl({ prompt: "none" }), { redirect: "manual" });
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("login_required");
    expect(location.searchParams.get("state")).toBe("state-123");
  });

  it("escapes values it puts back into the page", async () => {
    const { html } = await openSignIn({ login_hint: '"><script>x</script>' });
    expect(html).not.toContain("<script>x</script>");
  });
});

describe("authorization code flow", () => {
  it("redirects back with a code and the original state", async () => {
    const { response, location, code } = await signIn("admin@example.test");
    expect(response.status).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(code).not.toBe("");
  });

  it("exchanges the code for tokens that Kinde's validator accepts", async () => {
    const { code } = await signIn("admin@example.test", { nonce: "n-1", audience: "https://api.example.test" });
    const { status, body } = await exchange(codeGrant(code));
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "bearer", expires_in: 86400, scope: "openid profile email offline" });

    const access = decodeJwt(body.access_token as string);
    expect(access).toMatchObject({
      sub: "kp_admin",
      azp: CLIENT_ID,
      aud: ["https://api.example.test"],
      org_code: "org_acme",
      permissions: ["projects:read", "projects:delete"],
      scp: ["openid", "profile", "email", "offline"],
    });
    const id = decodeJwt(body.id_token as string);
    expect(id).toMatchObject({ sub: "kp_admin", aud: [CLIENT_ID], nonce: "n-1", org_codes: ["org_acme"], email: "admin@example.test" });

    for (const token of [body.access_token, body.id_token] as string[]) {
      expect(await validateToken({ token, domain: kinde.issuer, issuer: kinde.issuer })).toMatchObject({ valid: true });
    }
  });

  it("accepts client credentials sent with HTTP Basic", async () => {
    const { code } = await signIn("admin@example.test");
    const response = await fetch(`${kinde.url}/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:secret`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code }),
    });
    expect(response.status).toBe(200);
  });

  it("lets a code be used once", async () => {
    const { code } = await signIn("admin@example.test");
    expect((await exchange(codeGrant(code))).status).toBe(200);
    expect((await exchange(codeGrant(code))).body).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects a code sent with another redirect_uri or client", async () => {
    const first = await signIn("admin@example.test");
    expect((await exchange({ ...codeGrant(first.code), redirect_uri: "http://localhost:3000/other" })).body.error).toBe("invalid_grant");
    const second = await signIn("admin@example.test");
    expect((await exchange({ ...codeGrant(second.code), client_id: "another_client" })).body.error).toBe("invalid_grant");
  });

  it("checks a PKCE code_verifier", async () => {
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = { code_challenge: challenge, code_challenge_method: "S256" };

    const wrong = await signIn("admin@example.test", params);
    expect((await exchange({ ...codeGrant(wrong.code), code_verifier: "b".repeat(64) })).body.error).toBe("invalid_grant");

    const right = await signIn("admin@example.test", params);
    expect((await exchange({ ...codeGrant(right.code), code_verifier: verifier })).status).toBe(200);
  });

  it("only issues a refresh token for the offline scope", async () => {
    const { code } = await signIn("admin@example.test", { scope: "openid profile email" });
    const { body } = await exchange(codeGrant(code));
    expect(body.refresh_token).toBeUndefined();
    expect(body.id_token).toBeDefined();
  });

  it("rejects unknown grant types", async () => {
    const { status, body } = await exchange({ grant_type: "password", client_id: CLIENT_ID });
    expect(status).toBe(400);
    expect(body.error).toBe("unsupported_grant_type");
  });
});

describe("organizations", () => {
  it("asks which organization when the user has two", async () => {
    const { request } = await openSignIn();
    const response = await submit({ request, email: "consultant@example.test" });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Choose an organization");
    expect(html).toContain('value="org_globex"');

    const chosen = await submit({ request, user: "consultant@example.test", org: "org_globex" });
    const code = new URL(chosen.headers.get("location")!).searchParams.get("code")!;
    const access = decodeJwt((await exchange(codeGrant(code))).body.access_token as string);
    expect(access).toMatchObject({ org_code: "org_globex", roles: [expect.objectContaining({ key: "admin" })] });
  });

  it("uses org_code from the sign-in request", async () => {
    const { code } = await signIn("consultant@example.test", { org_code: "org_acme" });
    expect(decodeJwt((await exchange(codeGrant(code))).body.access_token as string).org_code).toBe("org_acme");
  });

  it("refuses an org_code the user does not belong to", async () => {
    const { response } = await signIn("admin@example.test", { org_code: "org_globex" });
    expect(response.status).toBe(403);
  });

  it("signs in an email that is not seeded, with no organization", async () => {
    const { code } = await signIn("new.person@example.test");
    const access = decodeJwt((await exchange(codeGrant(code))).body.access_token as string);
    expect(access.org_code).toBeUndefined();
    expect(access.sub).toMatch(/^kp_/);
  });
});

describe("refresh, profile, revoke and logout", () => {
  it("rotates refresh tokens", async () => {
    const { code } = await signIn("admin@example.test");
    const first = (await exchange(codeGrant(code))).body;
    const refreshed = await exchange({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: "x", refresh_token: first.refresh_token as string });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    expect(decodeJwt(refreshed.body.access_token as string).org_code).toBe("org_acme");

    const reused = await exchange({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: first.refresh_token as string });
    expect(reused.body.error).toBe("invalid_grant");
  });

  it("returns the user profile for a valid access token", async () => {
    const { code } = await signIn("admin@example.test");
    const { access_token } = (await exchange(codeGrant(code))).body;
    const response = await fetch(`${kinde.url}/oauth2/v2/user_profile`, { headers: { authorization: `Bearer ${access_token}` } });
    expect(await response.json()).toMatchObject({
      id: "kp_admin",
      sub: "kp_admin",
      email: "admin@example.test",
      given_name: "Ada",
      family_name: "Okafor",
      name: "Ada Okafor",
    });
    const bad = await fetch(`${kinde.url}/oauth2/v2/user_profile`, { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });

  it("revokes a refresh token", async () => {
    const { code } = await signIn("admin@example.test");
    const { refresh_token } = (await exchange(codeGrant(code))).body;
    const revoke = await fetch(`${kinde.url}/oauth2/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh_token as string, token_type_hint: "refresh_token" }),
    });
    expect(revoke.status).toBe(200);
    const after = await exchange({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh_token as string });
    expect(after.body.error).toBe("invalid_grant");
  });

  it("redirects after logout", async () => {
    const response = await fetch(`${kinde.url}/logout?redirect=${encodeURIComponent("http://localhost:3000")}`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000");
  });
});
