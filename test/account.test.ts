import { MemoryStorage, StorageKeys, getEntitlements, getFlag, getPermission, getPermissions, getRoles, setActiveStorage } from "@kinde/js-utils";
import { beforeEach, describe, expect, it } from "vitest";
import type { TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const seed: TestkitSeed = {
  users: [{ id: "kp_admin", email: "admin@example.test", properties: { team: "platform", seats: 3 } }],
  organizations: [{ code: "org_acme" }, { code: "org_globex" }],
  roles: [{ key: "admin", permissions: ["projects:read", "projects:delete"] }],
  memberships: [
    { user: "kp_admin", organization: "org_acme", roles: ["admin"], permissions: ["billing:view"] },
    { user: "kp_admin", organization: "org_globex", roles: [] },
  ],
  featureFlags: [
    { key: "new_editor", value: false, organizations: { org_acme: true } },
    { key: "theme", value: "light" },
  ],
  plans: [{ key: "pro", name: "Pro", subscribers: ["org_acme"], entitlements: [{ featureKey: "seats", featureName: "Seats", limitMax: 10 }] }],
};

const kinde = useKindeTestkit({ seed });
const storage = new MemoryStorage();
setActiveStorage(storage);

async function signInTo(organization: string) {
  const response = await fetch(`${kinde.url}/testkit/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "kp_admin", organization }),
  });
  const { access_token } = (await response.json()) as { access_token: string };
  await storage.setSessionItem(StorageKeys.accessToken, access_token);
  return access_token;
}

async function account(path: string, token: string) {
  const response = await fetch(`${kinde.url}/account_api/v1/${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

beforeEach(() => kinde.reset());

describe("Account API through @kinde/js-utils", () => {
  it("returns permissions from roles and direct grants", async () => {
    await signInTo("org_acme");
    expect(await getPermissions({ forceApi: true })).toEqual({ orgCode: "org_acme", permissions: ["billing:view", "projects:read", "projects:delete"] });
    expect(await getPermission("projects:delete", { forceApi: true })).toMatchObject({ data: { is_granted: true, org_code: "org_acme" } });
  });

  it("returns roles for the active organization", async () => {
    await signInTo("org_acme");
    expect(await getRoles({ forceApi: true })).toEqual([{ id: expect.stringMatching(/^role_/), name: "Admin", key: "admin" }]);
    await signInTo("org_globex");
    expect(await getRoles({ forceApi: true })).toEqual([]);
  });

  it("returns feature flags with organization overrides, also in the token", async () => {
    const token = await signInTo("org_acme");
    const { body } = await account("feature_flags", token);
    expect(body.data.feature_flags).toEqual([
      { id: expect.stringMatching(/^flag_/), name: "new_editor", key: "new_editor", type: "boolean", value: true },
      { id: expect.stringMatching(/^flag_/), name: "theme", key: "theme", type: "string", value: "light" },
    ]);
    expect(await getFlag("new_editor", { forceApi: true })).toBe(true);
    expect(await getFlag("theme")).toBe("light");
    await signInTo("org_globex");
    expect(await getFlag("new_editor")).toBe(false);
  });

  it("returns the organization's plan entitlements", async () => {
    await signInTo("org_acme");
    expect(await getEntitlements()).toEqual({
      orgCode: "org_acme",
      plans: [{ key: "pro", subscribedOn: expect.any(String) }],
      entitlements: [expect.objectContaining({ featureKey: "seats", featureName: "Seats", entitlementLimitMax: 10 })],
    });
  });

  it("returns user properties and pages with starting_after", async () => {
    const token = await signInTo("org_acme");
    const first = await account("properties?page_size=1", token);
    expect(first.body).toMatchObject({ data: { properties: [{ key: "team", value: "platform" }] }, metadata: { has_more: true } });
    const next = await account(`properties?page_size=1&starting_after=${first.body.metadata.next_page_starting_after}`, token);
    expect(next.body).toMatchObject({ data: { properties: [{ key: "seats", value: 3 }] }, metadata: { has_more: false } });
  });

  it("refuses M2M tokens and tokens from other issuers", async () => {
    expect((await account("permissions", await kinde.testkit.m2mToken({ clientId: "svc" }))).status).toBe(403);
    expect((await account("permissions", "not-a-token")).status).toBe(403);
  });
});
