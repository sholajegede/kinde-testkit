import { createKindeOrganization, createKindeUser, createMembership } from "./factories.js";
import { stableId, titleCase } from "./ids.js";
import { TestkitError } from "./errors.js";
import type {
  AuthenticatedScenario,
  KindeApplication,
  KindeMembership,
  KindeOrganization,
  KindeUser,
} from "./types.js";

export interface TestkitSeed {
  issuer?: string;
  audience?: string | string[];
  clientId?: string;
  users?: Array<{
    id: string;
    email?: string | null;
    emailVerified?: boolean;
    givenName?: string | null;
    familyName?: string | null;
    picture?: string | null;
    claims?: Record<string, unknown>;
    properties?: Record<string, string | number | boolean>;
  }>;
  organizations?: Array<{
    code: string;
    name?: string;
    metadata?: Record<string, unknown>;
  }>;
  memberships?: Array<{
    user: string;
    organization: string;
    roles?: string[];
    permissions?: string[];
  }>;
  webhooks?: Array<{ url: string; events?: string[] }>;
  roles?: Array<{ key: string; name?: string; description?: string; permissions?: string[]; isDefault?: boolean }>;
  featureFlags?: Array<{
    key: string;
    name?: string;
    type?: "boolean" | "string" | "integer";
    value: boolean | string | number;
    organizations?: Record<string, boolean | string | number>;
  }>;
  plans?: Array<{
    key: string;
    name?: string;
    subscribers?: string[];
    entitlements?: Array<{
      featureKey: string;
      featureName?: string;
      priceName?: string;
      fixedCharge?: number | null;
      unitAmount?: number | null;
      limitMax?: number | null;
      limitMin?: number | null;
    }>;
  }>;
  permissions?: Array<{ key: string; name?: string; description?: string }>;
  applications?: Array<{
    clientId: string;
    clientSecret?: string;
    name?: string;
    organization?: string;
    scopes?: string[];
    permissions?: string[];
    audience?: string | string[];
  }>;
}

export interface ResolvedSeed {
  users: KindeUser[];
  organizations: KindeOrganization[];
  memberships: KindeMembership[];
  applications: KindeApplication[];
  webhooks: Array<{ url: string; events?: string[] }>;
  roles: SeedRole[];
  permissions: SeedPermission[];
  featureFlags: SeedFeatureFlag[];
  plans: SeedPlan[];
  userProperties: Record<string, Record<string, string | number | boolean>>;
}

export interface SeedFeatureFlag {
  id: string;
  key: string;
  name: string;
  type: "boolean" | "string" | "integer";
  value: boolean | string | number;
  organizations: Record<string, boolean | string | number>;
}

export interface SeedPlan {
  key: string;
  name: string;
  subscribers: string[];
  subscribedOn: string;
  entitlements: Array<{
    id: string;
    featureKey: string;
    featureName: string;
    priceName: string;
    fixedCharge: number | null;
    unitAmount: number | null;
    limitMax: number | null;
    limitMin: number | null;
  }>;
}

export interface SeedRole {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  permissions: string[];
}

export interface SeedPermission {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

export function roleRecord(key: string, extra: Partial<Omit<SeedRole, "id" | "key">> = {}): SeedRole {
  return {
    id: stableId("role", key),
    key,
    name: extra.name ?? titleCase(key),
    description: extra.description ?? null,
    isDefault: extra.isDefault ?? false,
    permissions: [...(extra.permissions ?? [])],
  };
}

export function permissionRecord(key: string, extra: Partial<Omit<SeedPermission, "id" | "key">> = {}): SeedPermission {
  return {
    id: stableId("perm", key),
    key,
    name: extra.name ?? titleCase(key.replace(/[:.]/g, " ")),
    description: extra.description ?? null,
  };
}

export function effectivePermissions(seed: ResolvedSeed, membership: KindeMembership | undefined): string[] {
  if (!membership) return [];
  const fromRoles = membership.roles.flatMap((key) => seed.roles.find((role) => role.key === key)?.permissions ?? []);
  return [...new Set([...membership.permissions, ...fromRoles])];
}

export function resolveSeed(input: unknown): ResolvedSeed {
  const problems: string[] = [];
  if (!isRecord(input)) {
    throw new TestkitError("SEED_INVALID", "The seed must be a JSON object.");
  }
  const rawUsers = listOf(input.users, "users", problems);
  const rawOrganizations = listOf(input.organizations, "organizations", problems);
  const rawMemberships = listOf(input.memberships, "memberships", problems);
  const rawApplications = listOf(input.applications, "applications", problems);
  const rawWebhooks = listOf(input.webhooks, "webhooks", problems);
  const rawRoles = listOf(input.roles, "roles", problems);
  const rawFlags = listOf(input.featureFlags, "featureFlags", problems);
  const rawPlans = listOf(input.plans, "plans", problems);
  const rawPermissions = listOf(input.permissions, "permissions", problems);
  const webhooks: Array<{ url: string; events?: string[] }> = [];
  rawWebhooks.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) {
      problems.push(`webhooks[${index}] needs an http or https "url".`);
      return;
    }
    if (raw.events !== undefined && (!Array.isArray(raw.events) || raw.events.some((e) => typeof e !== "string"))) {
      problems.push(`webhooks[${index}].events must be a list of event type names.`);
      return;
    }
    webhooks.push({ url: raw.url, events: raw.events as string[] | undefined });
  });

  const users: KindeUser[] = [];
  rawUsers.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
      problems.push(`users[${index}] needs a string "id".`);
      return;
    }
    if (users.some((user) => user.id === raw.id)) {
      problems.push(`users[${index}] repeats the id "${raw.id}".`);
      return;
    }
    users.push(createKindeUser(raw as Parameters<typeof createKindeUser>[0]));
  });

  const organizations: KindeOrganization[] = [];
  rawOrganizations.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.code !== "string" || raw.code.length === 0) {
      problems.push(`organizations[${index}] needs a string "code".`);
      return;
    }
    if (organizations.some((org) => org.code === raw.code)) {
      problems.push(`organizations[${index}] repeats the code "${raw.code}".`);
      return;
    }
    organizations.push(createKindeOrganization(raw as Parameters<typeof createKindeOrganization>[0]));
  });

  const memberships: KindeMembership[] = [];
  rawMemberships.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.user !== "string" || typeof raw.organization !== "string") {
      problems.push(`memberships[${index}] needs string "user" and "organization" fields.`);
      return;
    }
    const user = findUser(users, raw.user);
    if (!user) problems.push(`memberships[${index}] points to an unknown user "${raw.user}".`);
    if (!organizations.some((org) => org.code === raw.organization)) {
      problems.push(`memberships[${index}] points to an unknown organization "${raw.organization}".`);
    }
    for (const field of ["roles", "permissions"] as const) {
      const value = raw[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
        problems.push(`memberships[${index}].${field} must be a list of strings.`);
      }
    }
    if (!user) return;
    if (memberships.some((m) => m.userId === user.id && m.organizationCode === raw.organization)) {
      problems.push(`memberships[${index}] repeats ${user.id} in ${raw.organization}.`);
      return;
    }
    memberships.push(
      createMembership({
        userId: user.id,
        organizationCode: raw.organization,
        roles: raw.roles as string[] | undefined,
        permissions: raw.permissions as string[] | undefined,
      }),
    );
  });

  const applications: KindeApplication[] = [];
  rawApplications.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.clientId !== "string" || raw.clientId.length === 0) {
      problems.push(`applications[${index}] needs a string "clientId".`);
      return;
    }
    if (applications.some((app) => app.clientId === raw.clientId)) {
      problems.push(`applications[${index}] repeats the clientId "${raw.clientId}".`);
      return;
    }
    if (raw.clientSecret !== undefined && typeof raw.clientSecret !== "string") {
      problems.push(`applications[${index}].clientSecret must be a string.`);
    }
    if (raw.organization !== undefined && !organizations.some((org) => org.code === raw.organization)) {
      problems.push(`applications[${index}] points to an unknown organization "${String(raw.organization)}".`);
    }
    for (const field of ["scopes", "permissions"] as const) {
      const value = raw[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
        problems.push(`applications[${index}].${field} must be a list of strings.`);
      }
    }
    const audience = raw.audience;
    applications.push({
      clientId: raw.clientId,
      clientSecret: typeof raw.clientSecret === "string" ? raw.clientSecret : null,
      name: typeof raw.name === "string" ? raw.name : raw.clientId,
      organizationCode: typeof raw.organization === "string" ? raw.organization : null,
      scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : null,
      permissions: Array.isArray(raw.permissions) ? (raw.permissions as string[]) : null,
      audience: typeof audience === "string" ? [audience] : Array.isArray(audience) ? (audience as string[]) : null,
    });
  });

  if (problems.length > 0) {
    throw new TestkitError("SEED_INVALID", "The seed has problems. Fix them and start again.", problems);
  }
  const permissions: SeedPermission[] = [];
  rawPermissions.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.key !== "string" || raw.key.length === 0) {
      problems.push(`permissions[${index}] needs a string "key".`);
      return;
    }
    if (permissions.some((p) => p.key === raw.key)) {
      problems.push(`permissions[${index}] repeats the key "${raw.key}".`);
      return;
    }
    permissions.push(
      permissionRecord(raw.key, {
        name: typeof raw.name === "string" ? raw.name : undefined,
        description: typeof raw.description === "string" ? raw.description : undefined,
      }),
    );
  });
  const roles: SeedRole[] = [];
  rawRoles.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.key !== "string" || raw.key.length === 0) {
      problems.push(`roles[${index}] needs a string "key".`);
      return;
    }
    if (roles.some((r) => r.key === raw.key)) {
      problems.push(`roles[${index}] repeats the key "${raw.key}".`);
      return;
    }
    if (raw.permissions !== undefined && (!Array.isArray(raw.permissions) || raw.permissions.some((p) => typeof p !== "string"))) {
      problems.push(`roles[${index}].permissions must be a list of permission keys.`);
      return;
    }
    roles.push(
      roleRecord(raw.key, {
        name: typeof raw.name === "string" ? raw.name : undefined,
        description: typeof raw.description === "string" ? raw.description : undefined,
        isDefault: raw.isDefault === true,
        permissions: (raw.permissions as string[] | undefined) ?? [],
      }),
    );
  });

  if (problems.length > 0) {
    throw new TestkitError("SEED_INVALID", "The seed has problems. Fix them and start again.", problems);
  }

  const featureFlags: SeedFeatureFlag[] = [];
  rawFlags.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.key !== "string" || !["boolean", "string", "number"].includes(typeof raw.value)) {
      problems.push(`featureFlags[${index}] needs a string "key" and a boolean, string or number "value".`);
      return;
    }
    const type = raw.type === "string" || raw.type === "integer" || raw.type === "boolean"
      ? raw.type
      : typeof raw.value === "number" ? "integer" : typeof raw.value === "string" ? "string" : "boolean";
    featureFlags.push({
      id: stableId("flag", raw.key),
      key: raw.key,
      name: typeof raw.name === "string" ? raw.name : raw.key,
      type,
      value: raw.value as boolean | string | number,
      organizations: isRecord(raw.organizations) ? (raw.organizations as Record<string, boolean | string | number>) : {},
    });
  });

  const plans: SeedPlan[] = [];
  rawPlans.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.key !== "string") {
      problems.push(`plans[${index}] needs a string "key".`);
      return;
    }
    const entitlements = Array.isArray(raw.entitlements) ? (raw.entitlements as Record<string, unknown>[]) : [];
    plans.push({
      key: raw.key,
      name: typeof raw.name === "string" ? raw.name : titleCase(raw.key),
      subscribers: Array.isArray(raw.subscribers) ? raw.subscribers.filter((s): s is string => typeof s === "string") : [],
      subscribedOn: new Date().toISOString(),
      entitlements: entitlements
        .filter((e) => typeof e.featureKey === "string")
        .map((e) => ({
          id: stableId("entitlement", `${raw.key as string}:${e.featureKey as string}`),
          featureKey: e.featureKey as string,
          featureName: typeof e.featureName === "string" ? e.featureName : titleCase(e.featureKey as string),
          priceName: typeof e.priceName === "string" ? e.priceName : titleCase(e.featureKey as string),
          fixedCharge: typeof e.fixedCharge === "number" ? e.fixedCharge : null,
          unitAmount: typeof e.unitAmount === "number" ? e.unitAmount : null,
          limitMax: typeof e.limitMax === "number" ? e.limitMax : null,
          limitMin: typeof e.limitMin === "number" ? e.limitMin : null,
        })),
    });
  });

  const userProperties: Record<string, Record<string, string | number | boolean>> = {};
  rawUsers.forEach((raw) => {
    if (isRecord(raw) && typeof raw.id === "string" && isRecord(raw.properties)) {
      userProperties[raw.id] = raw.properties as Record<string, string | number | boolean>;
    }
  });

  if (problems.length > 0) {
    throw new TestkitError("SEED_INVALID", "The seed has problems. Fix them and start again.", problems);
  }

  const usedRoles = new Set(memberships.flatMap((m) => m.roles));
  for (const key of usedRoles) if (!roles.some((r) => r.key === key)) roles.push(roleRecord(key));
  const usedPermissions = new Set([
    ...memberships.flatMap((m) => m.permissions),
    ...roles.flatMap((r) => r.permissions),
    ...applications.flatMap((a) => a.permissions ?? []),
  ]);
  for (const key of usedPermissions) if (!permissions.some((p) => p.key === key)) permissions.push(permissionRecord(key));

  return { users, organizations, memberships, applications, webhooks, roles, permissions, featureFlags, plans, userProperties };
}

export function findUser(users: KindeUser[], ref: string): KindeUser | undefined {
  const needle = ref.toLowerCase();
  return users.find((user) => user.id === ref || user.email?.toLowerCase() === needle);
}

export function seedScenario(
  seed: ResolvedSeed,
  ref: { user: string; organization?: string | null },
): AuthenticatedScenario {
  const user = findUser(seed.users, ref.user);
  if (!user) {
    throw new TestkitError("SEED_UNKNOWN_USER", `No seeded user matches "${ref.user}".`, [
      `Known users: ${seed.users.map((u) => u.email ?? u.id).join(", ") || "none"}`,
    ]);
  }
  const userMemberships = seed.memberships.filter((m) => m.userId === user.id);
  let membership: KindeMembership | undefined;

  if (ref.organization) {
    if (!seed.organizations.some((org) => org.code === ref.organization)) {
      throw new TestkitError(
        "SEED_UNKNOWN_ORGANIZATION",
        `No seeded organization has the code "${ref.organization}".`,
      );
    }
    membership = userMemberships.find((m) => m.organizationCode === ref.organization);
    if (!membership) {
      throw new TestkitError(
        "SEED_NO_MEMBERSHIP",
        `${user.email ?? user.id} is not a member of ${ref.organization}, so Kinde would not issue a token for that organization.`,
        [`Member of: ${userMemberships.map((m) => m.organizationCode).join(", ") || "no organizations"}`],
      );
    }
  } else if (userMemberships.length === 1) {
    membership = userMemberships[0];
  } else if (userMemberships.length > 1) {
    throw new TestkitError(
      "INVALID_REQUEST",
      `${user.email ?? user.id} belongs to ${userMemberships.length} organizations. Choose the active one.`,
      [`Organizations: ${userMemberships.map((m) => m.organizationCode).join(", ")}`],
    );
  }

  const organization = membership
    ? seed.organizations.find((org) => org.code === membership.organizationCode) ?? null
    : null;

  return {
    kind: "authenticated",
    user,
    organization,
    roles: [...(membership?.roles ?? [])],
    permissions: effectivePermissions(seed, membership),
    claims: {},
  };
}

function listOf(value: unknown, field: string, problems: string[]): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`"${field}" must be a list.`);
    return [];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function featureFlagsFor(
  seed: ResolvedSeed,
  organizationCode: string | null,
): Record<string, { t: "b" | "s" | "i"; v: boolean | string | number }> | undefined {
  if (seed.featureFlags.length === 0) return undefined;
  const claim: Record<string, { t: "b" | "s" | "i"; v: boolean | string | number }> = {};
  for (const flag of seed.featureFlags) {
    const value = organizationCode && organizationCode in flag.organizations ? flag.organizations[organizationCode]! : flag.value;
    claim[flag.key] = { t: flag.type === "boolean" ? "b" : flag.type === "integer" ? "i" : "s", v: value };
  }
  return claim;
}
