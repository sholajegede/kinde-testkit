import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { startKindeTestkit, TestkitError, resolveSeed, type TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [
    { id: "kp_admin", email: "admin@example.test", givenName: "Ada" },
    { id: "kp_viewer", email: "viewer@example.test" },
    { id: "kp_consultant", email: "consultant@example.test" },
  ],
  organizations: [
    { code: "org_acme", name: "Acme Inc." },
    { code: "org_globex", name: "Globex" },
  ],
  memberships: [
    { user: "kp_admin", organization: "org_acme", roles: ["admin"], permissions: ["projects:read", "projects:delete"] },
    { user: "kp_viewer", organization: "org_acme", roles: ["viewer"], permissions: ["projects:read"] },
    { user: "kp_consultant", organization: "org_acme", roles: ["viewer"], permissions: ["projects:read"] },
    { user: "kp_consultant", organization: "org_globex", roles: ["admin"], permissions: ["projects:delete"] },
  ],
};

const kinde = useKindeTestkit({ seed });

async function mint(body: Record<string, unknown>) {
  const response = await fetch(`${kinde.url}/testkit/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("discovery", () => {
  it("publishes an OIDC discovery document that points at the JWKS", async () => {
    const doc = (await (await fetch(`${kinde.url}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      issuer: kinde.issuer,
      jwks_uri: `${kinde.issuer}/.well-known/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
      response_types_supported: ["code"],
    });
  });

  it("publishes one RS256 signing key", async () => {
    const jwks = (await (await fetch(kinde.jwksUri)).json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: kinde.testkit.keyId });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("answers 501 for flows this release does not implement", async () => {
    const response = await fetch(`${kinde.url}/oauth2/token`, { method: "POST" });
    expect(response.status).toBe(501);
  });
});

describe("seeded tokens", () => {
  it("uses the membership's roles and permissions", async () => {
    const { status, body } = await mint({ user: "admin@example.test" });
    expect(status).toBe(200);
    expect(decodeJwt(body.access_token as string)).toMatchObject({
      sub: "kp_admin",
      org_code: "org_acme",
      permissions: ["projects:read", "projects:delete"],
    });
  });

  it("switches organization for a user with two memberships", async () => {
    const acme = decodeJwt((await mint({ user: "kp_consultant", organization: "org_acme" })).body.access_token as string);
    const globex = decodeJwt((await mint({ user: "kp_consultant", organization: "org_globex" })).body.access_token as string);
    expect(acme).toMatchObject({ org_code: "org_acme", permissions: ["projects:read"] });
    expect(globex).toMatchObject({ org_code: "org_globex", permissions: ["projects:delete"] });
  });

  it("asks for an organization when the user has more than one", async () => {
    const { status, body } = await mint({ user: "kp_consultant" });
    expect(status).toBe(400);
    expect(body.error).toBe("INVALID_REQUEST");
  });

  it("refuses an organization the user does not belong to", async () => {
    const { status, body } = await mint({ user: "kp_viewer", organization: "org_globex" });
    expect(status).toBe(400);
    expect(body.error).toBe("SEED_NO_MEMBERSHIP");
  });

  it("refuses an unknown user and an unknown invalid kind", async () => {
    expect((await mint({ user: "nobody@example.test" })).body.error).toBe("SEED_UNKNOWN_USER");
    expect((await mint({ subject: "kp_x", invalid: "sideways" })).body.error).toBe("INVALID_REQUEST");
  });

  it("lists seeded users and organizations", async () => {
    const users = (await (await fetch(`${kinde.url}/testkit/users`)).json()) as unknown[];
    const orgs = (await (await fetch(`${kinde.url}/testkit/organizations`)).json()) as unknown[];
    expect(users).toHaveLength(3);
    expect(orgs).toHaveLength(2);
  });
});

describe("safety", () => {
  it("refuses to bind to a public interface by default", async () => {
    await expect(startKindeTestkit({ host: "0.0.0.0", port: 0 })).rejects.toMatchObject({
      code: "PUBLIC_BIND_REFUSED",
    });
  });

  it("reports every seed problem at once", () => {
    let error: unknown;
    try {
      resolveSeed({
        users: [{ id: "kp_a" }, { id: "kp_a" }],
        organizations: [{ name: "No code" }],
        memberships: [{ user: "kp_missing", organization: "org_missing" }],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TestkitError);
    expect((error as TestkitError).details).toHaveLength(4);
  });

  it("gives each running issuer its own signing key", async () => {
    const other = await startKindeTestkit({ port: 0 });
    try {
      expect(other.testkit.keyId).not.toBe(kinde.testkit.keyId);
    } finally {
      await other.close();
    }
  });
});
