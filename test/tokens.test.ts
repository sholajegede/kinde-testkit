import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, errors } from "jose";
import { describe, expect, it } from "vitest";
import { scenario, type InvalidTokenKind } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const AUDIENCE = "https://api.example.test";
const kinde = useKindeTestkit({ audience: AUDIENCE });

const admin = scenario()
  .user({ email: "admin@example.test", givenName: "Ada", familyName: "Okafor" })
  .organization({ code: "org_acme", name: "Acme Inc." })
  .role("admin")
  .permissions(["projects:read", "projects:create", "projects:delete"])
  .authenticated();

async function verify(token: string, options: { maxTokenAge?: string } = {}) {
  const discovery = (await (await fetch(`${kinde.url}/.well-known/openid-configuration`)).json()) as {
    issuer: string;
    jwks_uri: string;
  };
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  return jwtVerify(token, jwks, {
    issuer: discovery.issuer,
    audience: AUDIENCE,
    algorithms: ["RS256"],
    ...options,
  });
}

async function tokenWith(invalid: InvalidTokenKind): Promise<string> {
  return (await kinde.testkit.tokenFor(admin, { invalid })) as string;
}

describe("valid access tokens", () => {
  it("verify against the published JWKS with issuer and audience checks", async () => {
    const { token } = await kinde.auth(admin);
    const { payload, protectedHeader } = await verify(token!);

    expect(protectedHeader).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(protectedHeader.kid).toMatch(/^kinde-testkit-/);
    expect(payload).toMatchObject({
      iss: kinde.issuer,
      aud: [AUDIENCE],
      sub: admin.user.id,
      org_code: "org_acme",
      permissions: ["projects:read", "projects:create", "projects:delete"],
      scp: ["openid", "profile", "email", "offline"],
    });
    expect(payload.roles).toEqual([{ id: expect.stringMatching(/^role_/), key: "admin", name: "Admin" }]);
    expect(typeof payload.jti).toBe("string");
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  it("returns a principal that matches the token", async () => {
    const auth = await kinde.auth(admin);
    expect(auth.principal).toEqual({
      subject: admin.user.id,
      issuer: kinde.issuer,
      organization: { code: "org_acme" },
      roles: ["admin"],
      permissions: ["projects:read", "projects:create", "projects:delete"],
      claims: {},
    });
    expect(auth.headers.authorization).toBe(`Bearer ${auth.token}`);
  });

  it("honours a custom lifetime", async () => {
    const token = (await kinde.testkit.tokenFor(admin, { expiresIn: "15m" })) as string;
    const { payload } = await verify(token);
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it("issues an ID token with profile claims and org_codes", async () => {
    const idToken = (await kinde.testkit.idTokenFor(admin)) as string;
    const claims = decodeJwt(idToken);
    expect(claims).toMatchObject({
      aud: [kinde.testkit.clientId],
      email: "admin@example.test",
      email_verified: true,
      given_name: "Ada",
      family_name: "Okafor",
      name: "Ada Okafor",
      org_codes: ["org_acme"],
      sub: admin.user.id,
    });
  });

  it("gives no token or headers to an anonymous scenario", async () => {
    const auth = await kinde.auth(scenario().unauthenticated());
    expect(auth).toEqual({ token: null, headers: {}, principal: null, request: { headers: {} } });
  });
});

describe("invalid access tokens fail real verification", () => {
  it("expired", async () => {
    await expect(verify(await tokenWith("expired"))).rejects.toBeInstanceOf(errors.JWTExpired);
  });

  it("wrong issuer", async () => {
    await expect(verify(await tokenWith("wrong-issuer"))).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "iss",
    });
  });

  it("wrong audience", async () => {
    await expect(verify(await tokenWith("wrong-audience"))).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
    });
  });

  it("future iat", async () => {
    await expect(verify(await tokenWith("future-iat"), { maxTokenAge: "1h" })).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "iat",
    });
  });

  it("tampered signature", async () => {
    await expect(verify(await tokenWith("bad-signature"))).rejects.toBeInstanceOf(
      errors.JWSSignatureVerificationFailed,
    );
  });

  it("signed by a key that is not in the JWKS", async () => {
    const token = await tokenWith("unknown-key");
    expect(decodeProtectedHeader(token).kid).toMatch(/^kinde-testkit-unknown-/);
    await expect(verify(token)).rejects.toBeInstanceOf(errors.JWKSNoMatchingKey);
  });

  it("unsigned (alg none)", async () => {
    const token = await tokenWith("unsigned");
    expect(decodeProtectedHeader(token).alg).toBe("none");
    await expect(verify(token)).rejects.toBeInstanceOf(Error);
  });
});

describe("tokens that verify but must fail app authorization", () => {
  it("missing subject", async () => {
    const { payload } = await verify(await tokenWith("missing-subject"));
    expect(payload.sub).toBeUndefined();
  });

  it("missing organization", async () => {
    const { payload } = await verify(await tokenWith("missing-organization"));
    expect(payload.org_code).toBeUndefined();
  });

  it("missing permissions", async () => {
    const { payload } = await verify(await tokenWith("missing-permissions"));
    expect(payload.permissions).toEqual([]);
  });
});
