import { expect, test } from "kinde-testkit/playwright";

test("signs in with Google and multi-factor authentication", async ({ page, kinde }) => {
  await kinde.signInAs("admin@example.test", { connection: "google", mfa: "passed" });
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as admin@example.test");
});

test("a cancelled Google sign-in leaves the user signed out", async ({ page, kinde }) => {
  // Kinde's Next.js SDK answers an OAuth error by starting sign-in again.
  await kinde.signInAs("admin@example.test", { connection: "google", providerResult: "cancelled" });
  await page.goto("/");
  await expect(page.getByText("You are signed out.")).toBeVisible();
});

test("a wrong verification code keeps the user on the sign-in page", async ({ page, kinde }) => {
  await kinde.signInAs("admin@example.test", { mfa: "failed" });
  await expect(page.getByText("The verification code is not correct.")).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("You are signed out.")).toBeVisible();
});
