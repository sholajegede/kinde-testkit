import { expect, test } from "kinde-testkit/playwright";

// Each parallel worker uses its own email, so workers never share an identity.
const auditor = () => `auditor+w${test.info().parallelIndex}@example.test`;

test("signs in as an identity that is not in the seed file", async ({ page, kinde }) => {
  await kinde.authenticateAs({ email: auditor(), organization: "org_acme", permissions: ["projects:read", "projects:delete"] });
  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "Delete Customer portal" })).toBeVisible();
});

test("changing an identity's permissions changes what the app shows", async ({ page, kinde }) => {
  await kinde.authenticateAs({ email: auditor(), organization: "org_acme", permissions: ["projects:read"] });
  await page.goto("/projects");
  await expect(page.getByText("Customer portal")).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);
});

test("a saved sign-in starts another browser context signed in", async ({ page, kinde, browser }, testInfo) => {
  await kinde.authenticateAs("admin@example.test");
  const path = testInfo.outputPath("admin.json");
  await kinde.saveState(path);

  const context = await browser.newContext({ storageState: path });
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByTestId("signed-in-as")).toHaveText("Signed in as admin@example.test");
  await context.close();
});
