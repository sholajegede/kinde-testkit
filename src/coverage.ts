import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InvalidTokenKind } from "./types.js";

export interface CoverageItem {
  id: string;
  label: string;
  hint: string;
}

export interface CoverageGroup {
  name: string;
  items: CoverageItem[];
}

export const COVERAGE_GROUPS: CoverageGroup[] = [
  {
    name: "Identity",
    items: [
      { id: "identity.user", label: "Signed-in user", hint: "Mint a token for a seeded user or sign one in." },
      { id: "identity.anonymous", label: "No user", hint: "Call a route with an unauthenticated scenario, which sends no token." },
      { id: "identity.no-organization", label: "User with no organization", hint: "Mint a valid user token without org_code." },
      { id: "identity.unseeded", label: "User not in the seed", hint: "Sign in with an email that is not seeded." },
      { id: "identity.id-token", label: "ID token", hint: "Sign in through the sign-in page so the app gets an ID token." },
      { id: "identity.suspended", label: "Suspended user refused", hint: "Suspend a user with the Management API, then sign them in." },
      { id: "identity.social", label: "Social sign-in", hint: "Sign in with a social connection, such as signInAs(email, { connection: \"google\" })." },
      { id: "identity.mfa", label: "Multi-factor sign-in", hint: "Sign in with { mfa: \"passed\" }." },
    ],
  },
  {
    name: "Organizations",
    items: [
      { id: "organization.token", label: "Token with an organization", hint: "Mint a token with org_code." },
      { id: "organization.two-for-one-user", label: "One user in two organizations", hint: "Mint tokens for the same user in two organizations." },
      { id: "organization.cross", label: "Users from different organizations", hint: "Mint tokens for users in two organizations to test cross-organization access." },
      { id: "organization.non-member", label: "Non-member refused", hint: "Ask for a token or sign-in for an organization the user does not belong to." },
      { id: "organization.missing", label: "Organization claim missing", hint: 'Mint a token with invalid: "missing-organization".' },
    ],
  },
  {
    name: "Permissions",
    items: [
      { id: "permission.granted", label: "Token with permissions", hint: "Mint a token that carries permissions." },
      { id: "permission.different-sets", label: "Different permissions in one organization", hint: "Mint tokens for two users in one organization with different permissions, such as an admin and a viewer." },
      { id: "permission.roles", label: "Token with roles", hint: "Mint a token for a member with roles." },
      { id: "permission.none", label: "Token with no permissions", hint: 'Mint a token with invalid: "missing-permissions", or for a member with none.' },
      { id: "permission.feature-flags", label: "Token with feature flags", hint: "Seed featureFlags and mint a token for a seeded user." },
    ],
  },
  {
    name: "Token validation",
    items: (["expired", "future-iat", "wrong-issuer", "wrong-audience", "bad-signature", "unknown-key", "unsigned", "missing-subject"] as const).map(
      (kind) => ({ id: `token.${kind}`, label: tokenLabel(kind), hint: `Mint a token with invalid: "${kind}".` }),
    ),
  },
  {
    name: "Sessions",
    items: [
      { id: "session.sign-in", label: "Sign-in through the sign-in page", hint: "Sign a user in through your app's login route." },
      { id: "session.refresh", label: "Refresh", hint: "Let the app refresh its session, or call the refresh_token grant." },
      { id: "session.sign-out", label: "Sign-out", hint: "Sign out through your app's logout route." },
      { id: "session.revoke", label: "Refresh token revoked", hint: "Call /oauth2/revoke, as some SDKs do on sign-out." },
      { id: "session.silent", label: "Silent sign-in with no session", hint: "Send prompt=none and handle login_required." },
      { id: "session.sign-in-refused", label: "Sign-in cancelled or failed", hint: "Sign in with { providerResult: \"cancelled\" } or { mfa: \"failed\" } and check the app's error handling." },
      { id: "session.device-approved", label: "Device sign-in", hint: "Run the device authorization flow and approve it with POST /testkit/device." },
    ],
  },
  {
    name: "Machine-to-machine",
    items: [
      { id: "m2m.token", label: "M2M token", hint: "Call the client_credentials grant or mint an M2M token." },
      { id: "m2m.scopes", label: "M2M token with scopes", hint: "Seed an application with scopes and request a token." },
      { id: "m2m.organization", label: "Organization-scoped M2M token", hint: "Seed an application with an organization." },
      { id: "m2m.invalid", label: "Invalid M2M token", hint: "Mint an M2M token with an invalid kind." },
    ],
  },
  {
    name: "Kinde APIs",
    items: [
      { id: "api.management-read", label: "Management API read", hint: "Read users or organizations through the Management API." },
      { id: "api.management-write", label: "Management API change", hint: "Create, update or delete through the Management API." },
      { id: "api.management-denied", label: "Management API refused", hint: "Call the Management API with a missing scope or the wrong token." },
      { id: "api.account", label: "Account API", hint: "Read permissions, roles or feature flags through the Account API." },
    ],
  },
  {
    name: "Webhooks",
    items: [
      { id: "webhook.delivered", label: "Event delivered", hint: "Send a webhook that your handler accepts." },
      { id: "webhook.duplicate", label: "Duplicate delivery", hint: "Send a webhook with duplicate: 2." },
      { id: "webhook.forged", label: "Forged signature", hint: 'Send a webhook with invalid: "bad-signature", "unknown-key" or "unsigned".' },
      { id: "webhook.stale", label: "Stale event", hint: 'Send a webhook with invalid: "stale".' },
      { id: "webhook.failed", label: "Delivery your handler refused", hint: "Send an event your handler answers with a status other than 200." },
    ],
  },
  {
    name: "Outages",
    items: [
      { id: "outage.error", label: "Kinde answers with an error", hint: "Inject a 500 or 503 on an endpoint the app calls." },
      { id: "outage.rate-limit", label: "Rate limit", hint: "Inject a 429." },
      { id: "outage.slow", label: "Slow answer", hint: "Inject a delay." },
      { id: "outage.timeout", label: "No answer", hint: "Inject a hang so the client hits its timeout." },
      { id: "outage.malformed", label: "Malformed answer", hint: "Inject a malformed response, such as invalid JSON from the token endpoint." },
    ],
  },
];

const ALL_IDS = new Set(COVERAGE_GROUPS.flatMap((group) => group.items.map((item) => item.id)));

function tokenLabel(kind: string): string {
  return {
    expired: "Expired token",
    "future-iat": "Token issued in the future",
    "wrong-issuer": "Wrong issuer",
    "wrong-audience": "Wrong audience",
    "bad-signature": "Tampered signature",
    "unknown-key": "Unknown signing key",
    unsigned: "Unsigned token",
    "missing-subject": "No subject",
  }[kind]!;
}

export interface CoverageGroupResult {
  name: string;
  covered: number;
  total: number;
  items: Array<CoverageItem & { covered: boolean; count: number }>;
}

export interface CoverageReport {
  covered: number;
  total: number;
  groups: CoverageGroupResult[];
}

export interface CoverageSnapshot {
  version: 1;
  hits: Record<string, number>;
}

/** Records which authentication scenarios the testkit produced during a test run. */
export class CoverageRecorder {
  private hits = new Map<string, number>();
  private userOrganizations = new Map<string, Set<string>>();
  private organizationUsers = new Map<string, Set<string>>();
  private organizationPermissionSets = new Map<string, Set<string>>();

  hit(id: string): void {
    if (!ALL_IDS.has(id)) return;
    this.hits.set(id, (this.hits.get(id) ?? 0) + 1);
  }

  /** Called for every access token the testkit signs. */
  observeAccessToken(payload: Record<string, unknown>, invalid: InvalidTokenKind | undefined): void {
    if (Array.isArray(payload.gty) && payload.gty.includes("client_credentials")) {
      this.hit("m2m.token");
      if (typeof payload.scope === "string" && payload.scope.length > 0) this.hit("m2m.scopes");
      if (typeof payload.org_code === "string") this.hit("m2m.organization");
      if (invalid) this.hit("m2m.invalid");
      return;
    }
    if (invalid === "missing-organization") return this.hit("organization.missing");
    if (invalid === "missing-permissions") return this.hit("permission.none");
    if (invalid) return this.hit(`token.${invalid}`);

    const subject = typeof payload.sub === "string" ? payload.sub : null;
    const organization = typeof payload.org_code === "string" ? payload.org_code : null;
    const permissions = Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [];
    if (subject) this.hit("identity.user");
    if (!organization) this.hit("identity.no-organization");
    if (permissions.length > 0) this.hit("permission.granted");
    else this.hit("permission.none");
    if (Array.isArray(payload.roles) && payload.roles.length > 0) this.hit("permission.roles");
    if (payload.feature_flags && Object.keys(payload.feature_flags as object).length > 0) this.hit("permission.feature-flags");
    if (!organization) return;

    this.hit("organization.token");
    if (subject) {
      const organizations = add(this.userOrganizations, subject, organization);
      if (organizations.size > 1) this.hit("organization.two-for-one-user");
      add(this.organizationUsers, organization, subject);
      const organizationsWithUsers = [...this.organizationUsers.entries()].filter(([, users]) => users.size > 0);
      const distinctUsers = new Set(organizationsWithUsers.flatMap(([, users]) => [...users]));
      if (organizationsWithUsers.length > 1 && distinctUsers.size > 1) this.hit("organization.cross");
    }
    const sets = add(this.organizationPermissionSets, organization, [...permissions].sort().join(" "));
    if (sets.size > 1) this.hit("permission.different-sets");
  }

  report(): CoverageReport {
    return buildReport(Object.fromEntries(this.hits));
  }

  snapshot(): CoverageSnapshot {
    return { version: 1, hits: Object.fromEntries(this.hits) };
  }

  reset(): void {
    this.hits.clear();
    this.userOrganizations.clear();
    this.organizationUsers.clear();
    this.organizationPermissionSets.clear();
  }

  /** Writes this run's snapshot to the coverage folder, so separate test files can be merged. */
  write(directory = DEFAULT_COVERAGE_DIRECTORY): string {
    const folder = resolve(directory);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(file, `${JSON.stringify(this.snapshot())}\n`);
    return file;
  }
}

export const DEFAULT_COVERAGE_DIRECTORY = join(".kinde-testkit", "coverage");

function add<K, V>(map: Map<K, Set<V>>, key: K, value: V): Set<V> {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
  return set;
}

export function buildReport(hits: Record<string, number>): CoverageReport {
  const groups = COVERAGE_GROUPS.map((group) => {
    const items = group.items.map((item) => ({ ...item, count: hits[item.id] ?? 0, covered: (hits[item.id] ?? 0) > 0 }));
    return { name: group.name, covered: items.filter((i) => i.covered).length, total: items.length, items };
  });
  return {
    covered: groups.reduce((sum, g) => sum + g.covered, 0),
    total: groups.reduce((sum, g) => sum + g.total, 0),
    groups,
  };
}

export function mergeSnapshots(snapshots: CoverageSnapshot[]): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const snapshot of snapshots) {
    for (const [id, count] of Object.entries(snapshot.hits ?? {})) hits[id] = (hits[id] ?? 0) + count;
  }
  return hits;
}

/** Reads and merges every snapshot in the coverage folder. */
export function readCoverageDirectory(directory = DEFAULT_COVERAGE_DIRECTORY): { files: number; report: CoverageReport } {
  const folder = resolve(directory);
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    // No folder yet: nothing was recorded.
  }
  const snapshots = names.map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")) as CoverageSnapshot);
  return { files: names.length, report: buildReport(mergeSnapshots(snapshots)) };
}

export function clearCoverageDirectory(directory = DEFAULT_COVERAGE_DIRECTORY): void {
  rmSync(resolve(directory), { recursive: true, force: true });
}

export function formatCoverageReport(report: CoverageReport, options: { missing?: boolean } = {}): string {
  const width = Math.max(...report.groups.map((g) => g.name.length)) + 3;
  const lines = ["Kinde authentication coverage", ""];
  for (const group of report.groups) {
    lines.push(`${group.name.padEnd(width)}${String(group.covered).padStart(2)}/${group.total}`);
  }
  lines.push("", `Overall: ${report.covered}/${report.total}`);
  if (options.missing !== false) {
    const missing = report.groups.flatMap((g) => g.items.filter((i) => !i.covered).map((i) => ({ group: g.name, ...i })));
    if (missing.length > 0) {
      lines.push("", "Not covered:");
      for (const item of missing) lines.push(`  ${item.group}: ${item.label}. ${item.hint}`);
    }
  }
  return lines.join("\n");
}
