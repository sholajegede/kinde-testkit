# Changelog

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
