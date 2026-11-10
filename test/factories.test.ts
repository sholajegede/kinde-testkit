import { describe, expect, it } from "vitest";
import {
  createKindeOrganization,
  createKindeUser,
  createMembership,
  resetFactories,
  scenario,
  KindeTestkit,
} from "../src/index.js";

describe("createKindeUser", () => {
  it("derives a stable id from the email", () => {
    const first = createKindeUser({ email: "jane@example.test" });
    const second = createKindeUser({ email: "jane@example.test" });
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^kp_[0-9a-f]{16}$/);
    expect(first.emailVerified).toBe(true);
  });

  it("keeps explicit ids and unverified emails", () => {
    const user = createKindeUser({ id: "kp_test_001", email: "new@example.test", emailVerified: false });
    expect(user).toMatchObject({ id: "kp_test_001", emailVerified: false, givenName: null });
  });

  it("supports users with no email", () => {
    resetFactories();
    const user = createKindeUser({ email: null });
    expect(user.email).toBeNull();
    expect(user.emailVerified).toBe(false);
    expect(user.id).toBe("kp_test_1");
  });
});

describe("createKindeOrganization", () => {
  it("builds a code from the name", () => {
    expect(createKindeOrganization({ name: "Globex Corp" })).toEqual({
      code: "org_globex_corp",
      name: "Globex Corp",
      metadata: {},
    });
  });

  it("builds a name from the code", () => {
    expect(createKindeOrganization({ code: "org_initech" }).name).toBe("Initech");
  });
});

describe("createMembership", () => {
  it("removes duplicate roles and permissions", () => {
    expect(
      createMembership({
        userId: "kp_1",
        organizationCode: "org_acme",
        roles: ["admin", "admin"],
        permissions: ["projects:read", "projects:read"],
      }),
    ).toEqual({ userId: "kp_1", organizationCode: "org_acme", roles: ["admin"], permissions: ["projects:read"] });
  });
});

describe("scenario()", () => {
  it("survives a JSON round trip and still produces a token", async () => {
    const viewer = scenario()
      .user({ email: "viewer@example.test" })
      .organization("org_acme")
      .role("viewer")
      .permissions(["projects:read"])
      .authenticated();
    const restored = JSON.parse(JSON.stringify(viewer));
    expect(restored).toEqual(viewer);

    const testkit = await KindeTestkit.create();
    const token = await testkit.tokenFor(restored);
    expect(token?.split(".")).toHaveLength(3);
  });

  it("can drop the organization", () => {
    const orgless = scenario().user().organization("org_acme").withoutOrganization().authenticated();
    expect(orgless.organization).toBeNull();
  });

  it("models one user in two organizations as two scenarios", () => {
    const user = createKindeUser({ email: "both@example.test" });
    const inAcme = scenario().user(user).organization("org_acme").role("admin").authenticated();
    const inGlobex = scenario().user(user).organization("org_globex").role("viewer").authenticated();
    expect(inAcme.user.id).toBe(inGlobex.user.id);
    expect([inAcme.organization?.code, inGlobex.organization?.code]).toEqual(["org_acme", "org_globex"]);
  });
});
