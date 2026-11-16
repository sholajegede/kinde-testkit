import { validateToken } from "@kinde/jwt-validator";
import { describe, expect, it } from "vitest";
import { scenario, type InvalidTokenKind } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const kinde = useKindeTestkit();

const member = scenario()
  .user({ email: "member@example.test" })
  .organization("org_acme")
  .role("member")
  .permissions(["projects:read"])
  .authenticated();

async function check(token: string) {
  return validateToken({ token, domain: kinde.issuer, issuer: kinde.issuer });
}

describe("Kinde's own JWT validator", () => {
  it("accepts kinde-testkit access and ID tokens", async () => {
    expect(await check((await kinde.testkit.tokenFor(member)) as string)).toMatchObject({ valid: true });
    expect(await check((await kinde.testkit.idTokenFor(member)) as string)).toMatchObject({ valid: true });
  });

  it.each<InvalidTokenKind>(["expired", "wrong-issuer", "bad-signature", "unknown-key"])(
    "rejects a %s token",
    async (invalid) => {
      const token = (await kinde.testkit.tokenFor(member, { invalid })) as string;
      expect((await check(token)).valid).toBe(false);
    },
  );
});
