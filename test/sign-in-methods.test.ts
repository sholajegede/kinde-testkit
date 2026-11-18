import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import type { TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [
    { id: "kp_admin", email: "admin@example.test" },
    { id: "kp_consultant", email: "consultant@example.test" },
  ],
  organizations: [{ code: "org_acme" }, { code: "org_globex" }],
  memberships: [
    { user: "kp_admin", organization: "org_acme", roles: ["admin"] },
    { user: "kp_consultant", organization: "org_acme", roles: [] },
    { user: "kp_consultant", organization: "org_globex", roles: [] },
  ],
};

const kinde = useKindeTestkit({ seed });
const redirectUri = "http://localhost:3000/api/auth/kinde_callback";
beforeEach(() => kinde.reset());

async function signIn(fields: Record<string, string>) {
  const page = await (await fetch(`${kinde.url}/oauth2/auth?client_id=app&response_type=code&scope=openid&state=s1&redirect_uri=${encodeURIComponent(redirectUri)}`)).text();
  const request = /name="request" value="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const response = await fetch(`${kinde.url}/oauth2/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, ...fields }),
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("location"), html: response.status === 303 ? "" : await response.text() };
}

async function tokensFrom(location: string) {
  const code = new URL(location).searchParams.get("code")!;
  const response = await fetch(`${kinde.url}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: "app", code, redirect_uri: redirectUri }),
  });
  const body = (await response.json()) as { access_token: string; id_token: string };
  return { access: decodeJwt(body.access_token), id: decodeJwt(body.id_token) };
}

describe("sign-in methods and outcomes", () => {
  it("shows the test options on the sign-in page", async () => {
    const page = await (await fetch(`${kinde.url}/oauth2/auth?client_id=app&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`)).text();
    expect(page).toContain('<label for="connection">Sign in with</label>');
    expect(page).toContain('<label for="mfa">Multi-factor authentication</label>');
  });

  it("records the email method in amr by default", async () => {
    const { status, location } = await signIn({ email: "admin@example.test" });
    expect(status).toBe(303);
    expect((await tokensFrom(location!)).access.amr).toEqual(["email"]);
  });

  it("signs in with a social connection and passed MFA", async () => {
    const { location } = await signIn({ email: "admin@example.test", connection: "google", mfa: "passed" });
    const { access, id } = await tokensFrom(location!);
    expect(access.amr).toEqual(["google", "mfa"]);
    expect(id.amr).toEqual(["google", "mfa"]);
  });

  it("returns access_denied to the app when the user cancels the provider", async () => {
    const { status, location } = await signIn({ email: "admin@example.test", connection: "github", provider_result: "cancelled" });
    expect(status).toBe(303);
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe(redirectUri);
    expect(Object.fromEntries(url.searchParams)).toEqual({ error: "access_denied", error_description: "The user cancelled sign-in with github.", state: "s1" });
  });

  it("returns server_error to the app when the provider fails", async () => {
    const { location } = await signIn({ email: "admin@example.test", connection: "microsoft", provider_result: "error" });
    expect(new URL(location!).searchParams.get("error")).toBe("server_error");
  });

  it("keeps the user on the sign-in page after a wrong MFA code", async () => {
    const { status, location, html } = await signIn({ email: "admin@example.test", mfa: "failed" });
    expect([status, location]).toEqual([401, null]);
    expect(html).toContain("The verification code is not correct.");
  });

  it("returns access_denied when the user cancels MFA", async () => {
    const { location } = await signIn({ email: "admin@example.test", mfa: "cancelled" });
    expect(new URL(location!).searchParams.get("error_description")).toBe("The user cancelled multi-factor authentication.");
  });

  it("keeps the method through the organization picker", async () => {
    const picker = await signIn({ email: "consultant@example.test", connection: "google", mfa: "passed" });
    expect(picker.status).toBe(200);
    expect(picker.html).toContain('name="connection" value="google"');
    const request = /name="request" value="([^"]+)"/.exec(picker.html)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const chosen = await fetch(`${kinde.url}/oauth2/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, user: "consultant@example.test", org: "org_globex", connection: "google", provider_result: "success", mfa: "passed" }),
      redirect: "manual",
    });
    const { access } = await tokensFrom(chosen.headers.get("location")!);
    expect(access).toMatchObject({ org_code: "org_globex", amr: ["google", "mfa"] });
  });

  it("refuses invalid test options", async () => {
    expect((await signIn({ email: "admin@example.test", mfa: "maybe" })).status).toBe(400);
  });

  it("counts social, MFA and refused sign-ins in coverage", async () => {
    await signIn({ email: "admin@example.test", connection: "google", mfa: "passed" });
    await signIn({ email: "admin@example.test", mfa: "failed" });
    const hits = kinde.coverage.report().groups.flatMap((g) => g.items).filter((i) => i.count > 0).map((i) => i.id);
    expect(hits).toEqual(expect.arrayContaining(["identity.social", "identity.mfa", "session.sign-in-refused"]));
  });
});
