import { randomBytes } from "node:crypto";
import { createKindeOrganization, createKindeUser, createMembership } from "./factories.js";
import { slug } from "./ids.js";
import { permissionRecord, roleRecord, type ResolvedSeed, type SeedPermission, type SeedRole } from "./seed.js";
import type { KindeMembership, KindeOrganization, KindeUser } from "./types.js";

export interface UserMeta {
  providedId: string | null;
  isSuspended: boolean;
  isPasswordResetRequested: boolean;
  createdOn: string;
  totalSignIns: number;
  lastSignedIn: string | null;
  /** Last sign-in time per organization code. */
  lastOrganizationSignIns: Record<string, string>;
}

export interface OrganizationMeta {
  externalId: string | null;
  handle: string;
  createdOn: string;
  isAllowRegistrations: boolean;
}

export class Directory {
  private readonly userMeta = new Map<string, UserMeta>();
  private readonly orgMeta = new Map<string, OrganizationMeta>();
  private snapshot: string;

  constructor(readonly seed: ResolvedSeed) {
    this.snapshot = JSON.stringify(seed);
  }

  restore(): void {
    const original = JSON.parse(this.snapshot) as ResolvedSeed;
    for (const key of ["users", "organizations", "memberships", "roles", "permissions"] as const) {
      (this.seed[key] as unknown[]).splice(0, this.seed[key].length, ...(original[key] as unknown[]));
    }
    this.userMeta.clear();
    this.orgMeta.clear();
  }

  /** Replaces the whole seed with another resolved seed, and makes it the state reset() returns to. */
  load(next: ResolvedSeed): void {
    for (const key of Object.keys(next) as Array<keyof ResolvedSeed>) {
      const current = this.seed[key];
      if (Array.isArray(current)) {
        (current as unknown[]).splice(0, current.length, ...(next[key] as unknown[]));
      } else {
        const record = current as Record<string, unknown>;
        for (const name of Object.keys(record)) delete record[name];
        Object.assign(record, next[key]);
      }
    }
    this.snapshot = JSON.stringify(this.seed);
    this.userMeta.clear();
    this.orgMeta.clear();
  }

  user(id: string): KindeUser | undefined {
    return this.seed.users.find((user) => user.id === id);
  }

  meta(user: KindeUser): UserMeta {
    let meta = this.userMeta.get(user.id);
    if (!meta) {
      meta = {
        providedId: null,
        isSuspended: false,
        isPasswordResetRequested: false,
        createdOn: new Date().toISOString(),
        totalSignIns: 0,
        lastSignedIn: null,
        lastOrganizationSignIns: {},
      };
      this.userMeta.set(user.id, meta);
    }
    return meta;
  }

  isSuspended(userId: string): boolean {
    return this.userMeta.get(userId)?.isSuspended ?? false;
  }

  recordSignIn(user: KindeUser, organizationCode: string | null): void {
    const meta = this.meta(user);
    meta.totalSignIns += 1;
    meta.lastSignedIn = new Date().toISOString();
    if (organizationCode) meta.lastOrganizationSignIns[organizationCode] = meta.lastSignedIn;
  }

  createUser(input: { email?: string | null; givenName?: string | null; familyName?: string | null; picture?: string | null; providedId?: string | null }): KindeUser {
    const user = createKindeUser({
      id: `kp_${randomBytes(16).toString("hex")}`,
      email: input.email ?? null,
      givenName: input.givenName ?? null,
      familyName: input.familyName ?? null,
      picture: input.picture ?? null,
    });
    this.seed.users.push(user);
    this.meta(user).providedId = input.providedId ?? null;
    return user;
  }

  deleteUser(id: string): boolean {
    const index = this.seed.users.findIndex((user) => user.id === id);
    if (index < 0) return false;
    this.seed.users.splice(index, 1);
    for (let i = this.seed.memberships.length - 1; i >= 0; i--) {
      if (this.seed.memberships[i]!.userId === id) this.seed.memberships.splice(i, 1);
    }
    this.userMeta.delete(id);
    return true;
  }

  organization(code: string): KindeOrganization | undefined {
    return this.seed.organizations.find((org) => org.code === code);
  }

  orgInfo(org: KindeOrganization): OrganizationMeta {
    let meta = this.orgMeta.get(org.code);
    if (!meta) {
      meta = {
        externalId: typeof org.metadata.external_id === "string" ? org.metadata.external_id : null,
        handle: slug(org.name),
        createdOn: new Date().toISOString(),
        isAllowRegistrations: false,
      };
      this.orgMeta.set(org.code, meta);
    }
    return meta;
  }

  createOrganization(input: { name: string; externalId?: string | null; handle?: string | null }): KindeOrganization {
    const org = createKindeOrganization({ code: `org_${randomBytes(6).toString("hex").slice(0, 11)}`, name: input.name });
    this.seed.organizations.push(org);
    const meta = this.orgInfo(org);
    meta.externalId = input.externalId ?? null;
    if (input.handle) meta.handle = input.handle;
    return org;
  }

  deleteOrganization(code: string): boolean {
    const index = this.seed.organizations.findIndex((org) => org.code === code);
    if (index < 0) return false;
    this.seed.organizations.splice(index, 1);
    for (let i = this.seed.memberships.length - 1; i >= 0; i--) {
      if (this.seed.memberships[i]!.organizationCode === code) this.seed.memberships.splice(i, 1);
    }
    this.orgMeta.delete(code);
    return true;
  }

  membership(userId: string, organizationCode: string): KindeMembership | undefined {
    return this.seed.memberships.find((m) => m.userId === userId && m.organizationCode === organizationCode);
  }

  addMembership(userId: string, organizationCode: string, roles: string[] = [], permissions: string[] = []): KindeMembership {
    const existing = this.membership(userId, organizationCode);
    if (existing) return existing;
    const membership = createMembership({ userId, organizationCode, roles, permissions });
    this.seed.memberships.push(membership);
    for (const key of roles) this.ensureRole(key);
    for (const key of permissions) this.ensurePermission(key);
    return membership;
  }

  removeMembership(userId: string, organizationCode: string): boolean {
    const index = this.seed.memberships.findIndex((m) => m.userId === userId && m.organizationCode === organizationCode);
    if (index < 0) return false;
    this.seed.memberships.splice(index, 1);
    return true;
  }

  role(idOrKey: string): SeedRole | undefined {
    return this.seed.roles.find((role) => role.id === idOrKey || role.key === idOrKey);
  }

  permission(idOrKey: string): SeedPermission | undefined {
    return this.seed.permissions.find((p) => p.id === idOrKey || p.key === idOrKey);
  }

  ensureRole(key: string, extra: Partial<Omit<SeedRole, "id" | "key">> = {}): SeedRole {
    const existing = this.role(key);
    if (existing) return existing;
    const role = roleRecord(key, extra);
    this.seed.roles.push(role);
    return role;
  }

  ensurePermission(key: string, extra: Partial<Omit<SeedPermission, "id" | "key">> = {}): SeedPermission {
    const existing = this.permission(key);
    if (existing) return existing;
    const permission = permissionRecord(key, extra);
    this.seed.permissions.push(permission);
    return permission;
  }

  deleteRole(id: string): SeedRole | undefined {
    const role = this.role(id);
    if (!role) return undefined;
    this.seed.roles.splice(this.seed.roles.indexOf(role), 1);
    for (const m of this.seed.memberships) m.roles = m.roles.filter((key) => key !== role.key);
    return role;
  }

  deletePermission(id: string): SeedPermission | undefined {
    const permission = this.permission(id);
    if (!permission) return undefined;
    this.seed.permissions.splice(this.seed.permissions.indexOf(permission), 1);
    for (const m of this.seed.memberships) m.permissions = m.permissions.filter((key) => key !== permission.key);
    for (const r of this.seed.roles) r.permissions = r.permissions.filter((key) => key !== permission.key);
    return permission;
  }
}
