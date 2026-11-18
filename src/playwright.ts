import { test as base, expect, type Page } from "@playwright/test";
import type { ActiveFailure, FailureRule } from "./failures.js";
import type { SendWebhookOptions, WebhookDelivery } from "./webhooks.js";

export interface KindeFixtureOptions {
  issuer: string;
  loginPath: string;
  logoutPath: string;
}

export interface SignInOptions {
  org?: string;
}

export interface KindeFixture {
  readonly issuer: string;
  readonly currentUser: string | null;
  signInAs(user: string, options?: SignInOptions): Promise<void>;
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
