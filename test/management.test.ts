import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [
    { id: "kp_admin", email: "admin@example.test", givenName: "Ada", familyName: "Okafor" },
    { id: "kp_viewer", email: "viewer@example.test" },
  ],
  organizations: [{ code: "org_acme", name: "Acme Inc." }],
  roles: [
    { key: "admin", name: "Admin", permissions: ["projects:read", "projects:delete"] },
    { key: "viewer", permissions: ["projects:read"] },
  ],
  memberships: [
    { user: "kp_admin", organization: "org_acme", roles: ["admin"] },
    { user: "kp_viewer", organization: "org_acme", roles: ["viewer"] },
  ],
  applications: [{ clientId: "readonly_m2m", scopes: ["read:users"] }],
};

const events: string[] = [];
let receiver: Server;
let receiverUrl = "";

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      events.push(String((decodeJwt(body) as { type: string }).type));
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => receiver.close(resolve)));

const kinde = useKindeTestkit({ seed });
let token = "";

async function m2mToken(clientId = "management", audience = `${kinde.issuer}/api`) {
  const response = await fetch(`${kinde.url}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: "x", audience, scope: "" }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

async function api(method: string, path: string, body?: unknown, bearer = token) {
  const response = await fetch(`${kinde.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeEach(async () => {
  kinde.reset();
  events.length = 0;
  kinde.webhooks.addEndpoint({ url: receiverUrl });
  token = await m2mToken();
});

describe("access", () => {
  it("needs an M2M token for the <issuer>/api audience", async () => {
    expect((await api("GET", "/api/v1/users", undefined, "")).status).toBe(403);
    const wrongAudience = await m2mToken("management", "https://api.example.test");
    expect((await api("GET", "/api/v1/users", undefined, wrongAudience)).body.errors[0].message).toContain("/api");
    const userToken = (await kinde.testkit.tokenFor(
      { kind: "authenticated", user: { id: "kp_admin", email: null, emailVerified: false, givenName: null, familyName: null, picture: null, claims: {} }, organization: null, roles: [], permissions: [], claims: {} },
      { audience: [`${kinde.issuer}/api`] },
    ))!;
    expect((await api("GET", "/api/v1/users", undefined, userToken)).status).toBe(403);
  });

  it("enforces the scopes of a seeded M2M app", async () => {
    const readonly = await m2mToken("readonly_m2m");
    expect(decodeJwt(readonly).scope).toBe("read:users");
    expect((await api("GET", "/api/v1/users", undefined, readonly)).status).toBe(200);
    const denied = await api("POST", "/api/v1/organization", { name: "Nope" }, readonly);
    expect(denied).toMatchObject({ status: 403, body: { errors: [{ code: "SCOPE_MISSING" }] } });
  });

  it("answers 404 with the route for endpoints it does not implement", async () => {
    const { status, body } = await api("GET", "/api/v1/apis");
    expect(status).toBe(404);
    expect(body.errors[0].code).toBe("ROUTE_NOT_FOUND");
  });
});

describe("users", () => {
  it("lists, filters and pages users", async () => {
    const all = await api("GET", "/api/v1/users");
    expect(all.body).toMatchObject({ code: "OK", users: [{ id: "kp_admin", email: "admin@example.test", first_name: "Ada", organizations: ["org_acme"] }, { id: "kp_viewer" }] });
    expect((await api("GET", "/api/v1/users?email=VIEWER@example.test")).body.users).toHaveLength(1);
    const first = await api("GET", "/api/v1/users?page_size=1");
    expect(first.body.users).toHaveLength(1);
    const second = await api("GET", `/api/v1/users?page_size=1&next_token=${first.body.next_token}`);
    expect(second.body.users[0].id).toBe("kp_viewer");
    expect(second.body.next_token).toBeNull();
  });

  it("creates a user who can then sign in, and sends user.created", async () => {
    const created = await api("POST", "/api/v1/user", {
      profile: { given_name: "Grace", family_name: "Hopper" },
      organization_code: "org_acme",
      identities: [{ type: "email", details: { email: "grace@example.test" } }],
    });
    expect(created.body).toMatchObject({ created: true, id: expect.stringMatching(/^kp_[0-9a-f]{32}$/), identities: [{ type: "email", result: { created: true } }] });
    expect((await api("GET", `/api/v1/user?id=${created.body.id}`)).body).toMatchObject({ preferred_email: "grace@example.test", first_name: "Grace", organizations: ["org_acme"] });

    const minted = await fetch(`${kinde.url}/testkit/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "grace@example.test" }) });
    expect(decodeJwt(((await minted.json()) as { access_token: string }).access_token)).toMatchObject({ sub: created.body.id, org_code: "org_acme" });
    await expect.poll(() => events).toContain("user.created");

    expect((await api("POST", "/api/v1/user", { identities: [{ type: "email", details: { email: "grace@example.test" } }] })).status).toBe(409);
  });

  it("suspends a user, who then cannot sign in", async () => {
    expect((await api("PATCH", "/api/v1/user?id=kp_viewer", { is_suspended: true })).body).toMatchObject({ id: "kp_viewer", is_suspended: true });
    const page = await fetch(`${kinde.url}/oauth2/auth?client_id=app&redirect_uri=${encodeURIComponent("http://localhost:3000/cb")}&response_type=code`);
    const request = /name="request" value="([^"]+)"/.exec(await page.text())![1]!;
    const login = await fetch(`${kinde.url}/oauth2/auth/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, email: "viewer@example.test" }), redirect: "manual" });
    expect(login.status).toBe(403);
    expect(await login.text()).toContain("is suspended");
  });

  it("deletes a user and their memberships", async () => {
    expect((await api("DELETE", "/api/v1/user?id=kp_viewer")).body).toEqual({ code: "OK", message: "Success" });
    expect((await api("GET", "/api/v1/user?id=kp_viewer")).status).toBe(404);
    expect((await api("GET", "/api/v1/organizations/org_acme/users")).body.organization_users.map((u: { id: string }) => u.id)).toEqual(["kp_admin"]);
    await expect.poll(() => events).toContain("user.deleted");
  });
});

describe("organizations and members", () => {
  it("creates, reads, updates and deletes an organization", async () => {
    const created = await api("POST", "/api/v1/organization", { name: "Globex Corp", external_id: "crm_42" });
    const code = created.body.organization.code;
    expect(code).toMatch(/^org_[0-9a-f]{11}$/);
    expect((await api("GET", `/api/v1/organization?code=${code}`)).body).toMatchObject({ code, name: "Globex Corp", handle: "globex_corp", external_id: "crm_42" });
    expect((await api("PATCH", `/api/v1/organization/${code}`, { name: "Globex" })).status).toBe(200);
    expect((await api("GET", "/api/v1/organizations")).body.organizations.map((o: { name: string }) => o.name)).toEqual(["Acme Inc.", "Globex"]);
    expect((await api("DELETE", `/api/v1/organization/${code}`)).status).toBe(200);
    await expect.poll(() => [...events].sort()).toEqual(["organization.created", "organization.deleted", "organization.updated"]);
  });

  it("adds a member with roles, and the token reflects the role's permissions", async () => {
    const user = await api("POST", "/api/v1/user", { identities: [{ type: "email", details: { email: "new.member@example.test" } }] });
    const added = await api("POST", "/api/v1/organizations/org_acme/users", { users: [{ id: user.body.id, roles: ["admin"] }, { id: "kp_missing" }] });
    expect(added.body).toMatchObject({ users_added: [user.body.id], users_blocked: ["kp_missing"] });

    const minted = await fetch(`${kinde.url}/testkit/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: user.body.id, organization: "org_acme" }) });
    expect(decodeJwt(((await minted.json()) as { access_token: string }).access_token).permissions).toEqual(["projects:read", "projects:delete"]);

    const permissions = await api("GET", `/api/v1/organizations/org_acme/users/${user.body.id}/permissions`);
    expect(permissions.body.permissions).toEqual([
      expect.objectContaining({ key: "projects:read", roles: [expect.objectContaining({ key: "admin" })] }),
      expect.objectContaining({ key: "projects:delete", roles: [expect.objectContaining({ key: "admin" })] }),
    ]);
  });

  it("grants and removes member roles and direct permissions", async () => {
    const roles = await api("GET", "/api/v1/roles");
    const admin = roles.body.roles.find((r: { key: string }) => r.key === "admin");
    expect((await api("POST", "/api/v1/organizations/org_acme/users/kp_viewer/roles", { role_id: admin.id })).status).toBe(200);
    expect((await api("GET", "/api/v1/organizations/org_acme/users/kp_viewer/roles")).body.roles.map((r: { key: string }) => r.key)).toEqual(["viewer", "admin"]);
    expect((await api("DELETE", `/api/v1/organizations/org_acme/users/kp_viewer/roles/${admin.id}`)).status).toBe(200);

    expect((await api("POST", "/api/v1/permissions", { key: "billing:manage", name: "Manage billing" })).status).toBe(201);
    const permission = (await api("GET", "/api/v1/permissions")).body.permissions.find((p: { key: string }) => p.key === "billing:manage");
    expect((await api("POST", "/api/v1/organizations/org_acme/users/kp_viewer/permissions", { permission_id: permission.id })).status).toBe(200);
    expect((await api("GET", "/api/v1/organizations/org_acme/users/kp_viewer/permissions")).body.permissions.map((p: { key: string }) => p.key)).toEqual(["billing:manage", "projects:read"]);
    expect((await api("DELETE", "/api/v1/organizations/org_acme/users/kp_viewer")).status).toBe(200);
    expect((await api("GET", "/api/v1/organizations/org_acme/users/kp_viewer/roles")).status).toBe(404);
  });

  it("creates and deletes roles", async () => {
    const created = await api("POST", "/api/v1/roles", { key: "billing_admin", name: "Billing admin", description: "Runs billing" });
    expect(created).toMatchObject({ status: 201, body: { role: { id: expect.stringMatching(/^role_/) } } });
    expect((await api("GET", `/api/v1/roles/${created.body.role.id}`)).body.role).toEqual({ id: created.body.role.id, key: "billing_admin", name: "Billing admin", description: "Runs billing", is_default_role: false });
    expect((await api("GET", `/api/v1/roles/${(await api("GET", "/api/v1/roles")).body.roles[0].id}/permissions`)).body.permissions.map((p: { key: string }) => p.key)).toEqual(["projects:read", "projects:delete"]);
    expect((await api("DELETE", `/api/v1/roles/${created.body.role.id}`)).status).toBe(200);
    await expect.poll(() => [...events].sort()).toEqual(["role.created", "role.deleted"]);
  });

  it("reset puts the seed back", async () => {
    await api("DELETE", "/api/v1/user?id=kp_admin");
    kinde.reset();
    token = await m2mToken();
    expect((await api("GET", "/api/v1/user?id=kp_admin")).status).toBe(200);
  });
});
