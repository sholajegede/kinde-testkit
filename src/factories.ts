import type { KindeMembership, KindeOrganization, KindeRole, KindeUser } from "./types.js";
import { nextSequence, resetSequences, slug, stableId, titleCase } from "./ids.js";

export interface CreateKindeUserOptions {
  id?: string;
  email?: string | null;
  emailVerified?: boolean;
  givenName?: string | null;
  familyName?: string | null;
  picture?: string | null;
  claims?: Record<string, unknown>;
}

export function createKindeUser(options: CreateKindeUserOptions = {}): KindeUser {
  const email =
    options.email === undefined ? `user-${nextSequence("user")}@example.test` : options.email;
  const id = options.id ?? (email ? stableId("kp", email) : `kp_test_${nextSequence("kp")}`);
  return {
    id,
    email,
    emailVerified: options.emailVerified ?? email !== null,
    givenName: options.givenName === undefined ? null : options.givenName,
    familyName: options.familyName === undefined ? null : options.familyName,
    picture: options.picture === undefined ? null : options.picture,
    claims: { ...(options.claims ?? {}) },
  };
}

export interface CreateKindeOrganizationOptions {
  code?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export function createKindeOrganization(
  options: CreateKindeOrganizationOptions = {},
): KindeOrganization {
  const code =
    options.code ??
    (options.name ? `org_${slug(options.name)}` : `org_test_${nextSequence("org")}`);
  return {
    code,
    name: options.name ?? titleCase(code),
    metadata: { ...(options.metadata ?? {}) },
  };
}

export interface CreateMembershipOptions {
  userId: string;
  organizationCode: string;
  roles?: string[];
  permissions?: string[];
}

export function createMembership(options: CreateMembershipOptions): KindeMembership {
  return {
    userId: options.userId,
    organizationCode: options.organizationCode,
    roles: unique(options.roles ?? []),
    permissions: unique(options.permissions ?? []),
  };
}

export function toKindeRole(role: string | KindeRole): KindeRole {
  if (typeof role !== "string") return role;
  return { id: stableId("role", role), key: role, name: titleCase(role) };
}

export function resetFactories(): void {
  resetSequences();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
