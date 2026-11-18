import { expect, test } from "@playwright/test";
import { appLoginUrl, readSignInRequest, resolveLocation, signInForm } from "kinde-testkit";

// The same HTTP steps the kindeSignIn Cypress command takes, run against the real Kinde Next.js SDK.
// Requests share the browser context's cookies, as cy.request shares the browser's.
test("signs in with requests only, as the Cypress command does", async ({ page, baseURL }) => {
  const request = page.context().request;
  const options = { user: "consultant@example.test", org: "org_globex" };

  const start = `${baseURL}${appLoginUrl("/api/auth/login", options)}`;
  const login = await request.get(start, { maxRedirects: 0 });
  const signInPage = resolveLocation(login.headers().location!, start);
  expect(signInPage).toContain("localhost:4400/oauth2/auth");

  const form = await request.get(signInPage);
  const posted = await request.post("http://localhost:4400/oauth2/auth/login", {
    form: signInForm(readSignInRequest(await form.text()), options),
    maxRedirects: 0,
  });
  expect(posted.status()).toBe(303);

  await page.goto(resolveLocation(posted.headers().location!, "http://localhost:4400/oauth2/auth/login"));
  await expect(page.getByTestId("signed-in-as")).toHaveText("Signed in as consultant@example.test");
  await expect(page.getByTestId("organization")).toHaveText("Organization: org_globex");
});
