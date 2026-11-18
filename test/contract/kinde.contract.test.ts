// Contract tests: send the same requests to a real Kinde business and to kinde-testkit, then compare the shapes.
// They run only when KINDE_CONTRACT_DOMAIN is set, so `npm test` never calls Kinde:
//
//   KINDE_CONTRACT_DOMAIN=https://<your-business>.kinde.com \
//   KINDE_CONTRACT_CLIENT_ID=<M2M app client ID> \
//   KINDE_CONTRACT_CLIENT_SECRET=<M2M app secret> \
//   npm run test:contract
//
// Use a test business. The M2M app needs the Management API scopes read:users, read:organizations,
// read:roles and read:permissions. The suite only reads. Without the client ID and secret it checks
// discovery and JWKS only.
import { decodeJwt } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startKindeTestkit, type RunningKindeTestkit } from "../../src/index.js";

const domain = process.env.KINDE_CONTRACT_DOMAIN?.replace(/\/+$/, "");
const clientId = process.env.KINDE_CONTRACT_CLIENT_ID;
const clientSecret = process.env.KINDE_CONTRACT_CLIENT_SECRET;

type Json = Record<string, unknown>;

function shape(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Fields the real response has that the testkit's lacks, or has with another type. */
function missingFields(real: Json, testkit: Json): string[] {
  return Object.keys(real)
    .filter((key) => !(key in testkit) || (real[key] !== null && testkit[key] !== null && shape(real[key]) !== shape(testkit[key])))
    .map((key) => (key in testkit ? `${key} (Kinde: ${shape(real[key])}, testkit: ${shape(testkit[key])})` : key))
    .sort();
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, init);
  const text = await response.text();
  try {
    return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
  } catch {
    // Kinde answers some errors, such as an unknown client, with plain text.
    return { status: response.status, body: { error_description: text.trim() } };
  }
}

async function m2mToken(base: string, id: string, secret: string): Promise<string> {
  const { status, body } = await json(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret, audience: `${base}/api` }),
  });
  if (status !== 200) {
    const description = String(body.error_description ?? "");
    const hint = description.includes("whitelisted")
      ? " In Kinde, open the M2M app, go to APIs, and authorize the Kinde Management API with the read scopes listed at the top of this file."
      : description === "not_found" || body.error === "invalid_client"
        ? " Kinde does not know this client ID and secret. Copy both from the M2M app's Details page in Kinde."
        : "";
    throw new Error(`${base}/oauth2/token answered ${status}: ${JSON.stringify(body)}.${hint}`);
  }
  return body.access_token as string;
}

describe.skipIf(!domain)("contract with a real Kinde business", () => {
  let testkit: RunningKindeTestkit;

  beforeAll(async () => {
    testkit = await startKindeTestkit({
      port: 0,
      seed: {
        users: [{ id: "kp_contract", email: "contract@example.test", givenName: "Contract", familyName: "User" }],
        organizations: [{ code: "org_contract", name: "Contract Inc." }],
        roles: [{ key: "admin", name: "Admin", permissions: ["projects:read"] }],
        memberships: [{ user: "kp_contract", organization: "org_contract", roles: ["admin"] }],
      },
    });
  });
  afterAll(() => testkit?.close());

  it("discovery has every endpoint Kinde publishes", async () => {
    const real = (await json(`${domain}/.well-known/openid-configuration`)).body;
    const local = (await json(`${testkit.url}/.well-known/openid-configuration`)).body;
    const endpoints = Object.keys(real).filter((key) => key.endsWith("_endpoint") || key === "jwks_uri" || key === "issuer");
    expect(endpoints.filter((key) => !(key in local)), "endpoints in Kinde's discovery document that the testkit lacks").toEqual([]);
    expect(real.id_token_signing_alg_values_supported).toEqual(local.id_token_signing_alg_values_supported);
  });

  it("JWKS keys have the same fields and algorithm", async () => {
    const real = (await json(`${domain}/.well-known/jwks.json`)).body as { keys: Json[] };
    const local = (await json(`${testkit.url}/.well-known/jwks.json`)).body as { keys: Json[] };
    expect(missingFields(real.keys[0]!, local.keys[0]!)).toEqual([]);
    expect(local.keys[0]!.alg).toBe(real.keys[0]!.alg);
    expect(local.keys[0]!.kty).toBe(real.keys[0]!.kty);
  });

  it("introspection refuses a request with no Bearer token the same way", async () => {
    const init = () => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: "x" }) });
    const real = await json(`${domain}/oauth2/introspect`, init());
    const local = await json(`${testkit.url}/oauth2/introspect`, init());
    expect(local.status).toBe(real.status);
    expect(local.body.error).toBe(real.body.error);
    expect(local.body.error_description).toBe(real.body.error_description);
  });

  it("registration refuses a client with no redirect URIs the same way", async () => {
    const init = () => ({ method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const real = await json(`${domain}/oauth2/register`, init());
    const local = await json(`${testkit.url}/oauth2/register`, init());
    expect(local).toEqual(real);
  });

  describe.skipIf(!clientId || !clientSecret)("with an M2M app", () => {
    let realToken = "";
    let localToken = "";

    beforeAll(async () => {
      realToken = await m2mToken(domain!, clientId!, clientSecret!);
      localToken = await m2mToken(testkit.url, "contract_m2m", "secret");
    });

    it("M2M access tokens have the same claims", () => {
      const real = decodeJwt(realToken) as Json;
      const local = decodeJwt(localToken) as Json;
      expect(missingFields(real, local)).toEqual([]);
      expect(missingFields(local, real).filter((claim) => claim !== "org_code"), "claims only the testkit adds").toEqual([]);
      expect(local.gty).toEqual(real.gty);
      expect(local.v).toBe(real.v);
    });

    it("the Management API refuses a request with no token the same way", async () => {
      const real = await json(`${domain}/api/v1/users`);
      const local = await json(`${testkit.url}/api/v1/users`);
      expect(local.status).toBe(real.status);
      expect(missingFields(real.body, local.body)).toEqual([]);
    });

    const lists: Array<[string, string]> = [
      ["/api/v1/users?page_size=1", "users"],
      ["/api/v1/organizations?page_size=1", "organizations"],
      ["/api/v1/roles?page_size=1", "roles"],
      ["/api/v1/permissions?page_size=1", "permissions"],
    ];

    it.each(lists)("GET %s returns the same fields", async (path, key) => {
      const real = await json(`${domain}${path}`, { headers: { authorization: `Bearer ${realToken}` } });
      const local = await json(`${testkit.url}${path}`, { headers: { authorization: `Bearer ${localToken}` } });
      expect(real.status, `Kinde answered ${real.status}: ${JSON.stringify(real.body)}`).toBe(200);
      expect(local.status).toBe(200);
      expect(missingFields(real.body, local.body), "top-level fields").toEqual([]);
      const realItem = (real.body[key] as Json[] | undefined)?.[0];
      const localItem = (local.body[key] as Json[] | undefined)?.[0];
      if (realItem && localItem) expect(missingFields(realItem, localItem), `fields of each item in ${key}`).toEqual([]);
    });
  });
});
