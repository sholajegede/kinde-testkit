const { scenario } = require("kinde-testkit");
const { useKindeTestkit } = require("kinde-testkit/jest");

const kinde = useKindeTestkit({
  seed: {
    users: [{ id: "kp_admin", email: "admin@example.test" }],
    organizations: [{ code: "org_acme" }],
    memberships: [{ user: "kp_admin", organization: "org_acme", roles: ["admin"], permissions: ["projects:delete"] }],
  },
});

beforeEach(() => kinde.reset());

test("mints a token for a seeded member that the issuer's JWKS verifies", async () => {
  const auth = await kinde.auth(scenario().user({ id: "kp_admin" }).organization("org_acme").permissions(["projects:delete"]).authenticated());
  const claims = await kinde.testkit.verify(auth.token);
  expect(claims).toMatchObject({ sub: "kp_admin", org_code: "org_acme", permissions: ["projects:delete"] });
  expect(auth.headers.authorization).toBe(`Bearer ${auth.token}`);
});

test("serves the sign-in endpoints over HTTP", async () => {
  const response = await fetch(`${kinde.url}/.well-known/openid-configuration`);
  expect((await response.json()).issuer).toBe(kinde.issuer);
});

test("sends no token for an unauthenticated scenario", async () => {
  const auth = await kinde.auth(scenario().unauthenticated());
  expect(auth).toMatchObject({ token: null, headers: {} });
});
