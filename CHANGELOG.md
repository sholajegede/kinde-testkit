# Changelog

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
