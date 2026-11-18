/**
 * Cypress commands for kinde-testkit. Import this file from cypress/support/e2e.ts:
 *
 *   import "kinde-testkit/cypress/support";
 *
 * Runs in the browser, so it calls the testkit with cy.request and never imports Node code.
 */
import { appLoginUrl, readSignInRequest, resolveLocation, signInFailure, signInForm, type RequestSignInOptions } from "./sign-in-flow.js";
import type { ActiveFailure, FailureRule } from "./failures.js";
import type { SendWebhookOptions, WebhookDelivery } from "./webhooks.js";

export interface KindeSignInOptions {
  /** Active organization, for users in more than one. */
  org?: string;
  /** Your app's login route. Default /api/auth/login, as in Kinde's Next.js SDK. */
  loginPath?: string;
}

export interface KindeSignOutOptions {
  /** Your app's logout route. Default /api/auth/logout. */
  logoutPath?: string;
}

export interface KindeTokenRequest {
  user?: string;
  organization?: string;
  subject?: string;
  permissions?: string[];
  roles?: string[];
  expiresIn?: string | number;
  invalid?: string;
  m2m?: boolean;
  clientId?: string;
  scopes?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cypress {
    // Matches Cypress's own declaration so the two merge.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interface Chainable<Subject = any> {
      /** Signs a seeded user in through your app's login route, with requests instead of the sign-in page. */
      kindeSignIn(user: string, options?: KindeSignInOptions): Chainable<void>;
      /** Opens your app's logout route. */
      kindeSignOut(options?: KindeSignOutOptions): Chainable<void>;
      /** Mints an access token from the testkit. */
      kindeToken(options: KindeTokenRequest): Chainable<string>;
      /** Makes a testkit endpoint fail, slow down or hang until the test ends. */
      kindeInjectFailure(rule: FailureRule): Chainable<ActiveFailure>;
      /** Removes the failures this test added. */
      kindeClearFailures(): Chainable<void>;
      /** Sends a signed webhook and yields the deliveries. */
      kindeSendWebhook(options: SendWebhookOptions): Chainable<WebhookDelivery[]>;
      /** Clears sessions, failures, webhook deliveries and Management API changes. */
      kindeReset(): Chainable<void>;
    }
  }
}

interface CyResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string | string[]>;
}

interface CyRequestOptions {
  method?: string;
  url: string;
  body?: unknown;
  form?: boolean;
  followRedirect?: boolean;
  failOnStatusCode?: boolean;
  log?: boolean;
}

interface CyChain<T = unknown> {
  then<R>(fn: (value: T) => R): CyChain<R extends CyChain<infer U> ? U : R>;
}

interface Cy {
  request<T = unknown>(options: CyRequestOptions): CyChain<CyResponse<T>>;
  visit(url: string): CyChain;
  wrap<T>(value: T, options?: { log?: boolean }): CyChain<T>;
  url(): CyChain<string>;
}

interface CypressStatic {
  env(name: string): unknown;
  config(name: string): unknown;
  Commands: { add(name: string, fn: (...args: never[]) => unknown): void };
  log(options: { name: string; message: string }): void;
}

declare const cy: Cy;
declare const Cypress: CypressStatic;
declare const afterEach: (fn: () => unknown) => void;

const injected: string[] = [];

function issuer(): string {
  const url = (Cypress.env("KINDE_TESTKIT_URL") as string | undefined) ?? (Cypress.env("KINDE_ISSUER_URL") as string | undefined);
  if (!url) {
    throw new Error(
      'kinde-testkit does not know where the issuer is. Call setupKindeTestkit(on, config) from setupNodeEvents in cypress.config, or set env KINDE_TESTKIT_URL.',
    );
  }
  return url.replace(/\/+$/, "");
}

function appBase(): string {
  const base = Cypress.config("baseUrl") as string | null;
  if (!base) throw new Error("Set baseUrl in cypress.config so kinde-testkit can find your app's login route.");
  return base.replace(/\/+$/, "");
}

function location(response: CyResponse, from: string): string {
  const header = response.headers.location;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error(`Expected a redirect from ${from}, got ${response.status}.`);
  return resolveLocation(value, from);
}

function control<T>(method: string, path: string, body?: unknown): CyChain<T> {
  return cy
    .request<T & { error_description?: string }>({ method, url: `${issuer()}${path}`, body, failOnStatusCode: false, log: false })
    .then((response) => {
      if (response.status >= 400 && response.status !== 404) {
        throw new Error(response.body?.error_description ?? `kinde-testkit answered ${response.status} for ${path}.`);
      }
      return response.body as T;
    }) as CyChain<T>;
}

Cypress.Commands.add("kindeSignIn", (user: string, options: KindeSignInOptions = {}) => {
  const signIn: RequestSignInOptions = { user, org: options.org };
  const start = `${appBase()}${appLoginUrl(options.loginPath ?? "/api/auth/login", signIn)}`;
  Cypress.log({ name: "kindeSignIn", message: options.org ? `${user} in ${options.org}` : user });
  return cy
    .request({ url: start, followRedirect: false, log: false })
    .then((response) => {
      const signInPage = location(response, start);
      if (!signInPage.startsWith(issuer())) {
        throw new Error(`Expected the login route to redirect to kinde-testkit at ${issuer()}, but it went to ${signInPage}. Check the app's KINDE_ISSUER_URL.`);
      }
      return cy.request<string>({ url: signInPage, log: false });
    })
    .then((page) =>
      cy.request<string>({
        method: "POST",
        url: `${issuer()}/oauth2/auth/login`,
        form: true,
        body: signInForm(readSignInRequest(page.body), signIn),
        followRedirect: false,
        failOnStatusCode: false,
        log: false,
      }),
    )
    .then((response) => {
      if (response.status !== 302 && response.status !== 303) throw signInFailure(response.status, String(response.body), signIn);
      return cy.visit(location(response, `${issuer()}/oauth2/auth/login`));
    });
});

Cypress.Commands.add("kindeSignOut", (options: KindeSignOutOptions = {}) => {
  return cy.visit(`${appBase()}${options.logoutPath ?? "/api/auth/logout"}`);
});

Cypress.Commands.add("kindeToken", (options: KindeTokenRequest) => {
  return control<{ access_token: string }>("POST", "/testkit/token", options).then((body) => body.access_token);
});

Cypress.Commands.add("kindeInjectFailure", (rule: FailureRule) => {
  return control<ActiveFailure>("POST", "/testkit/failures", rule).then((failure) => {
    injected.push(failure.id);
    return failure;
  });
});

function clearInjected(): CyChain<void> {
  const ids = injected.splice(0, injected.length);
  let chain: CyChain<unknown> = cy.wrap(null, { log: false });
  for (const id of ids) chain = chain.then(() => control("DELETE", `/testkit/failures/${encodeURIComponent(id)}`));
  return chain.then(() => undefined);
}

Cypress.Commands.add("kindeClearFailures", () => clearInjected());

Cypress.Commands.add("kindeSendWebhook", (options: SendWebhookOptions) => {
  return control<WebhookDelivery[]>("POST", "/testkit/webhooks", options);
});

Cypress.Commands.add("kindeReset", () => {
  injected.length = 0;
  return control("POST", "/testkit/reset").then(() => undefined);
});

afterEach(() => {
  if (injected.length > 0) return clearInjected();
  return undefined;
});
