import { test as base, expect, type Page } from "@playwright/test";
import type { ActiveFailure, FailureRule } from "./failures.js";
import type { SendWebhookOptions, WebhookDelivery } from "./webhooks.js";
import type { Identity } from "./directory.js";
import { signInFails, type SignInMethodOptions } from "./sign-in-flow.js";

export type { Identity };

export interface KindeFixtureOptions {
  issuer: string;
  loginPath: string;
  logoutPath: string;
}

export interface SignInOptions extends SignInMethodOptions {
  org?: string;
}

export interface KindeFixture {
  readonly issuer: string;
  readonly currentUser: string | null;
  signInAs(user: string, options?: SignInOptions): Promise<void>;
  /**
   * Signs in as a seeded user by email, or as an identity described inline. An inline identity is
   * created in the testkit with exactly these roles and permissions, so it needs no seed entry.
   */
  authenticateAs(identity: string | Identity): Promise<void>;
  /** Saves the browser's cookies and storage, so other tests can start signed in with test.use({ storageState }). */
  saveState(path: string): Promise<void>;
  switchOrganization(org: string): Promise<void>;
  signOut(): Promise<void>;
  injectFailure(rule: FailureRule): Promise<ActiveFailure>;
  clearFailures(): Promise<void>;
  sendWebhook(options: SendWebhookOptions): Promise<WebhookDelivery[]>;
}

interface ManagedKindeFixture extends KindeFixture {
  dispose(): Promise<void>;
}

export interface KindeTestOptions {
  kindeIssuer: string;
  kindeLoginPath: string;
  kindeLogoutPath: string;
}

export function createKindeFixture(page: Page, options: KindeFixtureOptions): ManagedKindeFixture {
  const issuer = new URL(options.issuer);
  const onIssuer = (url: URL) => url.origin === issuer.origin;
  let currentUser: string | null = null;
  const injected = new Set<string>();

  async function control(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${issuer.origin}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok && response.status !== 404) {
      const body = (await response.json().catch(() => ({}))) as { error_description?: string };
      throw new Error(body.error_description ?? `kinde-testkit answered ${response.status} for ${path}.`);
    }
    return response;
  }

  async function signInAs(user: string, signIn: SignInOptions = {}): Promise<void> {
    const params = new URLSearchParams({ login_hint: user });
    if (signIn.org) params.set("org_code", signIn.org);
    await page.goto(`${options.loginPath}?${params}`);

    if (!(onIssuer(new URL(page.url())) && new URL(page.url()).pathname === "/oauth2/auth")) {
      throw new Error(
        `Expected ${options.loginPath} to redirect to the kinde-testkit sign-in page at ${issuer.origin}, but the browser is at ${page.url()}. Check that the app's KINDE_ISSUER_URL is ${issuer.origin}.`,
      );
    }

    await page.getByLabel("Email").fill(user);
    if (signIn.connection) await page.getByLabel("Sign in with").selectOption(signIn.connection);
    if (signIn.providerResult) await page.getByLabel("Provider result").selectOption(signIn.providerResult);
    if (signIn.mfa) await page.getByLabel("Multi-factor authentication").selectOption(signIn.mfa);

    if (signInFails(signIn)) {
      // The sign-in is meant to fail. A wrong MFA code stays on the sign-in page with an error. A cancelled
      // or failed provider sends the app an OAuth error. What the app does next is up to the app (Kinde's
      // Next.js SDK starts sign-in again), so this waits until the app has received the error.
      if (signIn.mfa === "failed") {
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByText("The verification code is not correct.").waitFor();
        return;
      }
      const errorReachedApp = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return !onIssuer(url) && url.searchParams.has("error");
      });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await errorReachedApp;
      await page.waitForLoadState();
      return;
    }
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL((url) => !(onIssuer(url) && url.pathname === "/oauth2/auth"));

    const landed = new URL(page.url());
    if (onIssuer(landed)) {
      const alert = page.getByRole("alert");
      if (await alert.count()) {
        throw new Error(`kinde-testkit refused the sign-in: ${(await alert.innerText()).trim()}`);
      }
      if (await page.getByRole("heading", { name: "Choose an organization" }).count()) {
        throw new Error(`${user} belongs to more than one organization. Pass one with signInAs("${user}", { org: "org_..." }).`);
      }
      throw new Error(`Sign-in stopped on ${page.url()}.`);
    }

    await page.waitForURL((url) => !onIssuer(url) && !url.pathname.endsWith("/kinde_callback"));
    currentUser = user;
  }

  return {
    issuer: issuer.origin,
    get currentUser() {
      return currentUser;
    },
    signInAs,
    async authenticateAs(identity: string | Identity) {
      if (typeof identity === "string") return signInAs(identity);
      await control("/testkit/identities", { method: "POST", body: JSON.stringify(identity) });
      await signInAs(identity.email, identity.organization ? { org: identity.organization } : {});
    },
    async saveState(path: string) {
      await page.context().storageState({ path });
    },
    async switchOrganization(org: string) {
      if (!currentUser) throw new Error("Call signInAs() before switchOrganization().");
      await signInAs(currentUser, { org });
    },
    async signOut() {
      await page.goto(options.logoutPath);
      currentUser = null;
    },
    async injectFailure(rule: FailureRule) {
      const response = await control("/testkit/failures", { method: "POST", body: JSON.stringify(rule) });
      const failure = (await response.json()) as ActiveFailure;
      injected.add(failure.id);
      return failure;
    },
    async clearFailures() {
      await Promise.all([...injected].map((id) => control(`/testkit/failures/${id}`, { method: "DELETE" })));
      injected.clear();
    },
    async sendWebhook(webhook: SendWebhookOptions) {
      const response = await control("/testkit/webhooks", { method: "POST", body: JSON.stringify(webhook) });
      return (await response.json()) as WebhookDelivery[];
    },
    async dispose() {
      if (injected.size > 0) await this.clearFailures();
    },
  };
}

export const test = base.extend<KindeTestOptions & { kinde: KindeFixture }>({
  kindeIssuer: [process.env.KINDE_ISSUER_URL ?? "http://localhost:4400", { option: true }],
  kindeLoginPath: ["/api/auth/login", { option: true }],
  kindeLogoutPath: ["/api/auth/logout", { option: true }],
  kinde: async ({ page, kindeIssuer, kindeLoginPath, kindeLogoutPath }, use) => {
    const fixture = createKindeFixture(page, {
      issuer: kindeIssuer,
      loginPath: kindeLoginPath,
      logoutPath: kindeLogoutPath,
    });
    await use(fixture);
    await fixture.dispose();
  },
});

export { expect };
