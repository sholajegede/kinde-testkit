import { validateToken } from "@kinde/jwt-validator";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { principalFromClaims, type TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  organizations: [{ code: "org_acme" }],
  applications: [
    { clientId: "billing_worker", clientSecret: "billing_secret", scopes: ["read:invoices", "write:invoices"] },
    { clientId: "acme_agent", organization: "org_acme", permissions: ["read:users"], audience: "https://api.example.test" },
  ],
};

const kinde = useKindeTestkit({ seed });

async function clientCredentials(body: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(`${kinde.url}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ grant_type: "client_credentials", ...body }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string | number> };
}

describe("client_credentials grant", () => {
  it("issues a token in Kinde's M2M shape", async () => {
    const { status, body } = await clientCredentials({
      client_id: "billing_worker",
      client_secret: "billing_secret",
      audience: "https://api.example.test",
      scope: "read:invoices",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "bearer", scope: "read:invoices", expires_in: 86400 });

    const claims = decodeJwt(body.access_token as string);
    expect(Object.keys(claims).sort()).toEqual(["aud", "azp", "exp", "gty", "iat", "iss", "jti", "scope", "scp", "v"]);
    expect(claims).toMatchObject({
      aud: ["https://api.example.test"],
      azp: "billing_worker",
      gty: ["client_credentials"],
      scope: "read:invoices",
      scp: ["read:invoices"],
      v: "2",
    });
    expect(await validateToken({ token: body.access_token as string, domain: kinde.issuer, issuer: kinde.issuer })).toMatchObject({ valid: true });
  });

  it("only grants scopes the seeded application has", async () => {
    const { body } = await clientCredentials({
      client_id: "billing_worker",
      client_secret: "billing_secret",
      scope: "read:invoices delete:everything",
    });
    const claims = decodeJwt(body.access_token as string);
    expect(claims.scope).toBe("read:invoices");
    expect(claims.scp).toEqual(["read:invoices", "delete:everything"]);
  });

  it("adds org_code, permissions and the default audience for an org-scoped app", async () => {
    const { body } = await clientCredentials({ client_id: "acme_agent", client_secret: "anything" });
    expect(decodeJwt(body.access_token as string)).toMatchObject({
      org_code: "org_acme",
      permissions: ["read:users"],
      aud: ["https://api.example.test"],
      scope: "",
      scp: [],
    });
  });

  it("accepts credentials sent with HTTP Basic", async () => {
    const basic = Buffer.from("billing_worker:billing_secret").toString("base64");
    const { status } = await clientCredentials({}, { authorization: `Basic ${basic}` });
    expect(status).toBe(200);
  });

  it("rejects a wrong secret for a seeded app", async () => {
    const { status, body } = await clientCredentials({ client_id: "billing_worker", client_secret: "wrong" });
    expect(status).toBe(401);
    expect(body.error).toBe("invalid_client");
  });

  it("accepts any client that is not seeded", async () => {
    const { status, body } = await clientCredentials({ client_id: "unknown_service" });
    expect(status).toBe(200);
    expect(decodeJwt(body.access_token as string)).not.toHaveProperty("org_code");
  });
});

describe("M2M tokens from the library", () => {
  it("mints M2M tokens with invalid variants", async () => {
    const valid = decodeJwt(await kinde.testkit.m2mToken({ clientId: "svc", organizationCode: "org_acme", scopes: ["read:users"] }));
    expect(valid).toMatchObject({ azp: "svc", org_code: "org_acme", gty: ["client_credentials"] });

    const missingOrg = decodeJwt(await kinde.testkit.m2mToken({ clientId: "svc", organizationCode: "org_acme", invalid: "missing-organization" }));
    expect(missingOrg).not.toHaveProperty("org_code");

    const expired = await kinde.testkit.m2mToken({ clientId: "svc", invalid: "expired" });
    expect(decodeJwt(expired).exp! < Date.now() / 1000).toBe(true);
  });

  it("reads an M2M token as a machine principal", async () => {
    const claims = decodeJwt(await kinde.testkit.m2mToken({ clientId: "svc", organizationCode: "org_acme" }));
    expect(principalFromClaims(claims)).toMatchObject({ type: "machine", subject: "svc", organization: { code: "org_acme" } });
  });

  it("mints M2M tokens through /testkit/token", async () => {
    const response = await fetch(`${kinde.url}/testkit/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ m2m: true, clientId: "acme_agent", scopes: ["read:users"] }),
    });
    const claims = decodeJwt(((await response.json()) as { access_token: string }).access_token);
    expect(claims).toMatchObject({ azp: "acme_agent", org_code: "org_acme", scp: ["read:users"] });
  });
});
