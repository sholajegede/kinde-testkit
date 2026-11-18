import { createKindeOrganization, createKindeUser, createMembership } from "./factories.js";
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
  return { users, organizations, memberships, applications };
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
    permissions: [...(membership?.permissions ?? [])],
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
