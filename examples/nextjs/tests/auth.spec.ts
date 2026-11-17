import { expect, test } from "kinde-testkit/playwright";

test("an admin signs in and can delete projects", async ({ page, kinde }) => {
  await kinde.signInAs("admin@example.test");

  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as admin@example.test");
  await expect(page.getByTestId("organization")).toHaveText("Organization: org_acme");

  await page.goto("/projects");
  await expect(page.getByRole("button", { name: "Delete Customer portal" })).toBeVisible();
});

test("a viewer sees projects but cannot delete them", async ({ page, kinde }) => {
  await kinde.signInAs("viewer@example.test");
  await page.goto("/projects");

  await expect(page.getByText("Customer portal")).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);
});

test("a user in two organizations switches between them", async ({ page, kinde }) => {
  await kinde.signInAs("consultant@example.test", { org: "org_acme" });
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "org_acme projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);

  await kinde.switchOrganization("org_globex");
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "org_globex projects" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Data warehouse" })).toBeVisible();
});

test("signing out ends the session", async ({ page, kinde }) => {
  await kinde.signInAs("admin@example.test");
  await kinde.signOut();

  await page.goto("/");
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await page.goto("/projects");
  await expect(page).toHaveURL(/localhost:4400\/oauth2\/auth/);
});

test("the sign-in page refuses an organization the user is not in", async ({ kinde }) => {
  await expect(kinde.signInAs("viewer@example.test", { org: "org_globex" })).rejects.toThrow(
    "viewer@example.test is not a member of org_globex",
  );
});
