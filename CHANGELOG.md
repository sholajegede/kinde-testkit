# Changelog

## 0.7.1

- Management API responses now have every field a real Kinde business returns: `full_name` and `last_organization_sign_ins` on users, `created_on` on organizations in lists, and `is_organization_role_assignable` on permissions. Found by the contract tests.

## 0.7.0

Found by running the new contract tests against a real Kinde business.

- Add the device authorization flow: `POST /oauth2/device/auth`, a `/device` page where the user enters the code and signs in, polling with `authorization_pending`, `slow_down`, `access_denied` and `expired_token`, and `POST /testkit/device` to approve or deny without a browser. Change timing with the `device` option.
- Add token introspection at `/oauth2/introspect` and dynamic client registration at `/oauth2/register`, with the same errors Kinde returns.
- A seeded application that lists `audience` may now only request those audiences, and gets Kinde's "has not been whitelisted" error for any other.
- The discovery document now lists the same endpoints and grant types as a Kinde business.
- Coverage adds a device sign-in item.
- The contract tests also compare introspection and registration errors, and explain how to authorize the Management API when Kinde refuses the M2M token.

## 0.6.1

- Cut the package from 923 kB to 321 kB. The ESM entry points now share one copy of the issuer instead of each bundling its own.
- With `--json`, CLI errors are one JSON object with `code`, `message` and `details`, so scripts and coding agents can read why a command failed. Error details no longer print twice.
- Add contract tests that compare discovery, JWKS, M2M token claims and Management API responses with a real Kinde business. Run them with `npm run test:contract`.
- Add a contents list and a section for coding agents to the README.
- Fix the Next.js example's Cypress outage test, which failed because the first visit landed on the testkit.

## 0.6.0

- Add `kinde-testkit/jest` with the same `useKindeTestkit()` and `kindeTest()` as the Vitest helper, for CommonJS and ESM test files.
- Add Cypress support: `setupKindeTestkit()` starts the testkit from `setupNodeEvents`, and `kinde-testkit/cypress/support` adds `cy.kindeSignIn()`, `cy.kindeSignOut()`, `cy.kindeToken()`, `cy.kindeInjectFailure()`, `cy.kindeClearFailures()`, `cy.kindeSendWebhook()` and `cy.kindeReset()`.
- Load seed files in YAML, JavaScript and TypeScript as well as JSON, and replace a running issuer's seed with `kinde-testkit seed <file>`.
- Add a dashboard at `/dashboard` with the seed, recent tokens, requests, webhook deliveries, failure rules and coverage, plus reset and send forms.
- Add an authentication coverage report: the testkit records which identity, organization, permission, token, session, M2M, API, webhook and outage cases a run produced. Read it with `kinde-testkit coverage`, and fail CI below a number with `--min`.
- Add a Dockerfile that runs the issuer as a non-root user with a health check, plus Docker Compose instructions.
- The Next.js example adds Cypress tests.

## 0.5.0

- Add the Management API at `/api/v1`: users, organizations, organization members, member roles and permissions, roles and permissions. It needs an M2M token for `<issuer>/api`, checks the scopes of seeded applications, and writes every change into the testkit's data. Changes send the matching webhooks. Unimplemented routes answer 404 `ROUTE_NOT_FOUND`.
- Add the Account API at `/account_api/v1`: permissions, roles, feature flags, properties, entitlements and the portal link, for the active organization of the user's token. Kinde's `@kinde/js-utils` helpers work against it.
- Add HTTPS mode (`https: true`, `start --https`, `kinde-testkit cert`) with a local certificate, so Kinde's official `@kinde/management-api-js` client runs unchanged. CLI commands given an `https://` URL trust the certificate on their own.
- The seed takes `roles` with permissions, `permissions`, `featureFlags` with organization values, `plans` with entitlements, and user `properties`. A role's permissions are added to the member's token. Feature flags go into access tokens.
- Suspended users cannot sign in, and `reset()` restores the seed after API changes.

## 0.4.0

- Add signed webhooks in Kinde's format: a JWT body with `Content-Type: application/jwt` and a `webhook-id` header, decodable with `@kinde/webhooks`.
- Build payloads for the 16 event types `@kinde/webhooks` defines from seeded users, organizations, roles and permissions. Send billing events, and any other type, with your own `data`.
- Deliver to endpoints from the seed's `webhooks`, `start --webhook`, `addEndpoint()` or a `to` URL, with event filters, Kinde's rule that only a 200 counts as delivered, fast retries with the same `webhook-id`, timeouts, and a delivery log.
- Test the hard cases with `duplicate`, and with `invalid` set to `bad-signature`, `unknown-key`, `unsigned` or `stale`.
- Signing in on the testkit page sends `user.authenticated`, and a first sign-in with an unseeded email sends `user.created`.
- Add `kinde-testkit webhook`, `kinde.webhooks` in Vitest, `kinde.sendWebhook()` in Playwright, and `/testkit/webhooks` endpoints.
- The Next.js example adds a webhook route with tests for valid, duplicated, forged and stale events.

## 0.3.0

- Add the `client_credentials` grant with Kinde's machine-to-machine token shape (`gty`, `scope`, `scp`, `v`, no `sub`), seeded `applications` with secrets, scopes, permissions, audiences and organizations, `testkit.m2mToken()`, and `kinde-testkit token --m2m`.
- Add failure injection: make any endpoint answer with an error status, wait, or hang, matched by path, prefix, method and count. Use it from Vitest (`kinde.failures`), Playwright (`kinde.injectFailure()`), the CLI (`kinde-testkit fail`) or HTTP (`/testkit/failures`).
- Add `kinde-testkit doctor`, which checks an app's Kinde settings against the running issuer, `kinde-testkit inspect`, which decodes a token and explains what is wrong with it, and `kinde-testkit reset`.
- `principalFromClaims()` now returns `type`, which is `"machine"` for M2M tokens, with the client ID as `subject`.
- The Next.js example adds outage tests that run through the real SDK.

## 0.2.2

- Show the README diagrams as images, so they display on npm as well as GitHub.

## 0.2.1

- Add CI on GitHub Actions: typecheck, tests and build on Node 22 and 24, a runtime check of the built package on Node 20, and the Next.js example's browser tests.
- Upgrade the development toolchain to Vitest 5 and esbuild 0.28. Nothing changes in the published package.

## 0.2.0

- Add the authorization code flow: a sign-in page at `/oauth2/auth` with seeded users, an organization picker, `org_code`, `login_hint`, `nonce`, `audience`, PKCE and `prompt=none`.
- Add `/oauth2/token` with the `authorization_code` and `refresh_token` grants. Refresh tokens rotate on every use.
- Add `/oauth2/v2/user_profile`, `/oauth2/revoke` and `/logout`.
- Add the `kinde-testkit/playwright` fixture with `signInAs`, `switchOrganization` and `signOut`.
- Add `examples/nextjs`, a Next.js app on `@kinde-oss/kinde-auth-nextjs` with Playwright tests that sign in through the testkit.
- Tokens issued through sign-in carry the requesting app's client ID in `azp` and the ID token's `aud`.

## 0.1.0

- First release: factories, the `scenario()` builder, Kinde-shaped access and ID tokens, 10 invalid token kinds, a local issuer with discovery and JWKS, seed files, the CLI and the Vitest helper.
