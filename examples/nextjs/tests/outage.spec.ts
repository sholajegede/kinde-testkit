import { expect, test } from "kinde-testkit/playwright";

test.describe.configure({ mode: "serial" });

test("sign-in fails cleanly when Kinde's token endpoint is down", async ({ page, kinde }) => {
  await kinde.injectFailure({ path: "/oauth2/token", status: 503, times: 1 });

  await page.goto("/api/auth/login?login_hint=admin@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page).toHaveURL(/\/api\/auth\/kinde_callback/);
  await expect(page.locator("body")).toContainText("kinde-testkit injected a 503 response.");

  await kinde.signInAs("admin@example.test");
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as admin@example.test");
});

test("a slow token endpoint still completes sign-in", async ({ page, kinde }) => {
  await kinde.injectFailure({ path: "/oauth2/token", delayMs: 2000, times: 1 });
  const started = Date.now();
  await kinde.signInAs("viewer@example.test");
  expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as viewer@example.test");
});
