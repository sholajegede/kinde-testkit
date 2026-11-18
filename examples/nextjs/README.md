# kinde-testkit with Next.js

A Next.js app on `@kinde-oss/kinde-auth-nextjs`, tested in a real browser without a Kinde account. Playwright starts kinde-testkit on port 4400 with the users in `kinde-testkit.json`, starts the app with `KINDE_ISSUER_URL` pointed at it, and signs in through the app's own `/api/auth/login` route.

The tests in `tests/auth.spec.ts` cover:

- an admin who can delete projects
- a viewer who can read but not delete
- a user in two organizations switching between them
- signing out
- an organization the user does not belong to

`tests/outage.spec.ts` runs after those, in its own Playwright project, because failure rules apply to the whole issuer. It takes Kinde's token endpoint down during sign-in, then slows it down by two seconds.

## Run it

The example installs kinde-testkit from this repository, so build it first:

```bash
cd ../..
npm install
npm run build
cd examples/nextjs
npm install
npx playwright install chromium
npm run test:e2e
```
