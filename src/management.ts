import type { IncomingMessage, ServerResponse } from "node:http";
import type { JWTPayload } from "jose";
import type { Directory } from "./directory.js";
import { effectivePermissions } from "./seed.js";
import type { KindeTestkit } from "./testkit.js";
import type { KindeOrganization, KindeUser } from "./types.js";
import type { WebhookDispatcher } from "./webhooks.js";

type Body = Record<string, unknown>;
type Handler = (ctx: RequestContext) => Promise<[number, unknown]> | [number, unknown];

interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
}

const OK = { code: "OK", message: "Success" };
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 500;

export class ManagementApi {
  private readonly routes: Array<{ method: string; pattern: RegExp; keys: string[]; scope: string; handler: Handler }> = [];

  constructor(
    private readonly testkit: KindeTestkit,
    private readonly directory: Directory,
    private readonly webhooks: WebhookDispatcher,
  ) {
    this.register();
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, readBody: () => Promise<Body>): Promise<boolean> {
    if (!url.pathname.startsWith("/api/v1/")) return false;
    const method = req.method ?? "GET";
    const route = this.routes.find((r) => r.method === method && r.pattern.test(url.pathname));
    if (!route) {
      sendJson(res, 404, errors("ROUTE_NOT_FOUND", `kinde-testkit does not implement ${method} ${url.pathname}.`));
      return true;
    }

    const token = await this.authenticate(req.headers.authorization);
    if ("error" in token) {
      sendJson(res, 403, errors(token.code, token.error));
      return true;
    }
    const granted = typeof token.payload.scope === "string" ? token.payload.scope.split(" ").filter(Boolean) : [];
    if (granted.length > 0 && !granted.includes(route.scope)) {
      sendJson(res, 403, errors("SCOPE_MISSING", `The token needs the ${route.scope} scope.`));
      return true;
    }

    const match = route.pattern.exec(url.pathname)!;
    const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
    const body = method === "GET" || method === "DELETE" ? {} : await readBody();
    const [status, payload] = await route.handler({ params, query: url.searchParams, body });
    sendJson(res, status, payload);
    return true;
  }

  private async authenticate(
    header: string | undefined,
  ): Promise<{ payload: JWTPayload } | { error: string; code: string }> {
    if (!header?.startsWith("Bearer ")) {
      return { code: "TOKEN_MISSING", error: "Send a machine-to-machine access token as a Bearer token." };
    }
    let payload: JWTPayload;
    try {
      payload = await this.testkit.verify(header.slice(7));
    } catch {
      return { code: "TOKEN_INVALID", error: "The access token is not valid for this issuer." };
    }
    const audience = `${this.testkit.issuer}/api`;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(audience)) {
      return { code: "TOKEN_INVALID", error: `The access token's audience must include ${audience}.` };
    }
    if (!Array.isArray(payload.gty) || !payload.gty.includes("client_credentials")) {
      return { code: "TOKEN_INVALID", error: "The Management API needs a machine-to-machine token from the client_credentials grant." };
    }
    return { payload };
  }

  private route(method: string, path: string, scope: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/\{(\w+)\}/g, (_, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.routes.push({ method, pattern, keys, scope, handler });
  }

  private register(): void {
    const d = this.directory;

    this.route("GET", "/api/v1/users", "read:users", ({ query }) => {
      let users = [...d.seed.users];
      const userId = query.get("user_id");
      const email = query.get("email")?.toLowerCase();
      if (userId) users = users.filter((u) => u.id === userId);
      if (email) users = users.filter((u) => u.email?.toLowerCase() === email);
      const page = paginate(users, query);
      return [200, { ...OK, users: page.items.map((u) => this.userListItem(u)), next_token: page.nextToken }];
    });

    this.route("GET", "/api/v1/user", "read:users", ({ query }) => {
      const user = d.user(query.get("id") ?? "");
      return user ? [200, this.userDetail(user)] : notFound("USER_INVALID", "No user has that id.");
    });

    this.route("POST", "/api/v1/user", "create:users", ({ body }) => {
      const profile = (body.profile ?? {}) as Body;
      const identities = Array.isArray(body.identities) ? (body.identities as Body[]) : [];
      const emailIdentity = identities.find((i) => i.type === "email");
      const email = ((emailIdentity?.details ?? {}) as Body).email;
      if (typeof email === "string" && d.seed.users.some((u) => u.email?.toLowerCase() === email.toLowerCase())) {
        return [409, errors("USER_ALREADY_EXISTS", `A user with the email ${email} already exists.`)];
      }
      const orgCode = typeof body.organization_code === "string" ? body.organization_code : null;
      if (orgCode && !d.organization(orgCode)) return notFound("ORGANIZATION_INVALID", `No organization has the code ${orgCode}.`);
      const user = d.createUser({
        email: typeof email === "string" ? email : null,
        givenName: str(profile.given_name),
        familyName: str(profile.family_name),
        picture: str(profile.picture),
        providedId: str(body.provided_id),
      });
      if (orgCode) d.addMembership(user.id, orgCode);
      this.webhooks.emit("user.created", { user: this.webhooks.userEventData(user) });
      return [
        200,
        { id: user.id, created: true, identities: identities.map((i) => ({ type: i.type, result: { created: true } })) },
      ];
    });

    this.route("PATCH", "/api/v1/user", "update:users", ({ query, body }) => {
      const user = d.user(query.get("id") ?? "");
      if (!user) return notFound("USER_INVALID", "No user has that id.");
      if (typeof body.given_name === "string") user.givenName = body.given_name;
      if (typeof body.family_name === "string") user.familyName = body.family_name;
      if (typeof body.picture === "string") user.picture = body.picture;
      const meta = d.meta(user);
      if (typeof body.is_suspended === "boolean") meta.isSuspended = body.is_suspended;
      if (typeof body.is_password_reset_requested === "boolean") meta.isPasswordResetRequested = body.is_password_reset_requested;
      if (typeof body.provided_id === "string") meta.providedId = body.provided_id;
      this.webhooks.emit("user.updated", { user: this.webhooks.userEventData(user) });
      return [
        200,
        {
          id: user.id,
          given_name: user.givenName,
          family_name: user.familyName,
          email: user.email,
          is_suspended: meta.isSuspended,
          is_password_reset_requested: meta.isPasswordResetRequested,
          picture: user.picture,
        },
      ];
    });

    this.route("DELETE", "/api/v1/user", "delete:users", ({ query }) => {
      const id = query.get("id") ?? "";
      if (!d.deleteUser(id)) return notFound("USER_INVALID", "No user has that id.");
      this.webhooks.emit("user.deleted", { user: { id } });
      return [200, OK];
    });

    this.route("GET", "/api/v1/organizations", "read:organizations", ({ query }) => {
      const page = paginate(d.seed.organizations, query);
      return [200, { ...OK, organizations: page.items.map((o) => this.organizationItem(o)), next_token: page.nextToken }];
    });

    this.route("GET", "/api/v1/organization", "read:organizations", ({ query }) => {
      const org = d.organization(query.get("code") ?? "");
      if (!org) return notFound("ORGANIZATION_INVALID", "No organization has that code.");
      const meta = d.orgInfo(org);
      return [200, { ...this.organizationItem(org), created_on: meta.createdOn, is_allow_registrations: meta.isAllowRegistrations }];
    });

    this.route("POST", "/api/v1/organization", "create:organizations", ({ body }) => {
      if (typeof body.name !== "string" || body.name.trim() === "") {
        return [400, errors("NAME_REQUIRED", "An organization needs a name.")];
      }
      const org = d.createOrganization({ name: body.name, externalId: str(body.external_id), handle: str(body.handle) });
      if (typeof body.is_allow_registrations === "boolean") d.orgInfo(org).isAllowRegistrations = body.is_allow_registrations;
      this.webhooks.emit("organization.created", { organization: this.organizationEvent(org) });
      return [200, { ...OK, organization: { code: org.code } }];
    });

    this.route("PATCH", "/api/v1/organization/{org_code}", "update:organizations", ({ params, body }) => {
      const org = d.organization(params.org_code!);
      if (!org) return notFound("ORGANIZATION_INVALID", "No organization has that code.");
      const meta = d.orgInfo(org);
      if (typeof body.name === "string") org.name = body.name;
      if (typeof body.external_id === "string") meta.externalId = body.external_id;
      if (typeof body.handle === "string") meta.handle = body.handle;
      if (typeof body.is_allow_registrations === "boolean") meta.isAllowRegistrations = body.is_allow_registrations;
      this.webhooks.emit("organization.updated", {
        organization: { ...this.organizationEvent(org), is_allow_registrations: meta.isAllowRegistrations },
      });
      return [200, OK];
    });

    this.route("DELETE", "/api/v1/organization/{org_code}", "delete:organizations", ({ params }) => {
      if (!d.deleteOrganization(params.org_code!)) return notFound("ORGANIZATION_INVALID", "No organization has that code.");
      this.webhooks.emit("organization.deleted", { organization: { code: params.org_code } });
      return [200, OK];
    });

    this.route("GET", "/api/v1/organizations/{org_code}/users", "read:organization_users", ({ params, query }) => {
      if (!d.organization(params.org_code!)) return notFound("ORGANIZATION_INVALID", "No organization has that code.");
      const members = d.seed.memberships
        .filter((m) => m.organizationCode === params.org_code)
        .map((m) => ({ membership: m, user: d.user(m.userId) }))
        .filter((m): m is { membership: typeof m.membership; user: KindeUser } => m.user !== undefined);
      const page = paginate(members, query);
      return [
        200,
        {
          ...OK,
          organization_users: page.items.map(({ membership, user }) => ({
            id: user.id,
            email: user.email,
            full_name: [user.givenName, user.familyName].filter(Boolean).join(" "),
            last_name: user.familyName,
            first_name: user.givenName,
            picture: user.picture,
            joined_on: d.meta(user).createdOn,
            last_accessed_on: d.meta(user).lastSignedIn,
            is_suspended: d.meta(user).isSuspended,
            roles: [...membership.roles],
          })),
          next_token: page.nextToken,
        },
      ];
    });

    this.route("POST", "/api/v1/organizations/{org_code}/users", "create:organization_users", ({ params, body }) => {
      if (!d.organization(params.org_code!)) return notFound("ORGANIZATION_INVALID", "No organization has that code.");
      const users = Array.isArray(body.users) ? (body.users as Body[]) : [];
      const added: string[] = [];
      const blocked: string[] = [];
      for (const entry of users) {
        const id = typeof entry.id === "string" ? entry.id : "";
        if (!d.user(id)) {
          blocked.push(id);
          continue;
        }
        d.addMembership(id, params.org_code!, strings(entry.roles), strings(entry.permissions));
        added.push(id);
      }
      return [200, { ...OK, users_added: added, users_blocked: blocked }];
    });

    this.route("DELETE", "/api/v1/organizations/{org_code}/users/{user_id}", "delete:organization_users", ({ params }) => {
      return d.removeMembership(params.user_id!, params.org_code!)
        ? [200, OK]
        : notFound("MEMBERSHIP_INVALID", `${params.user_id} is not a member of ${params.org_code}.`);
    });

    this.route("GET", "/api/v1/organizations/{org_code}/users/{user_id}/roles", "read:organization_user_roles", ({ params }) => {
      const membership = d.membership(params.user_id!, params.org_code!);
      if (!membership) return notFound("MEMBERSHIP_INVALID", `${params.user_id} is not a member of ${params.org_code}.`);
      const roles = membership.roles.map((key) => d.ensureRole(key));
      return [200, { ...OK, roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name })) }];
    });

    this.route("POST", "/api/v1/organizations/{org_code}/users/{user_id}/roles", "create:organization_user_roles", ({ params, body }) => {
      const membership = d.membership(params.user_id!, params.org_code!);
      if (!membership) return notFound("MEMBERSHIP_INVALID", `${params.user_id} is not a member of ${params.org_code}.`);
      const role = d.role(str(body.role_id) ?? "");
      if (!role) return notFound("ROLE_INVALID", "No role has that id.");
      if (!membership.roles.includes(role.key)) membership.roles.push(role.key);
      return [200, OK];
    });

    this.route("DELETE", "/api/v1/organizations/{org_code}/users/{user_id}/roles/{role_id}", "delete:organization_user_roles", ({ params }) => {
      const membership = d.membership(params.user_id!, params.org_code!);
      const role = d.role(params.role_id!);
      if (!membership || !role) return notFound("ROLE_INVALID", "No such role on that member.");
      membership.roles = membership.roles.filter((key) => key !== role.key);
      return [200, OK];
    });

    this.route("GET", "/api/v1/organizations/{org_code}/users/{user_id}/permissions", "read:organization_user_permissions", ({ params }) => {
      const membership = d.membership(params.user_id!, params.org_code!);
      if (!membership) return notFound("MEMBERSHIP_INVALID", `${params.user_id} is not a member of ${params.org_code}.`);
      const permissions = effectivePermissions(d.seed, membership).map((key) => {
        const permission = d.ensurePermission(key);
        const roles = membership.roles
          .map((roleKey) => d.role(roleKey))
          .filter((role) => role?.permissions.includes(key))
          .map((role) => ({ id: role!.id, key: role!.key }));
        return { id: permission.id, key: permission.key, name: permission.name, description: permission.description, roles };
      });
      return [200, { ...OK, permissions }];
    });

    this.route("POST", "/api/v1/organizations/{org_code}/users/{user_id}/permissions", "create:organization_user_permissions", ({ params, body }) => {
      const membership = d.membership(params.user_id!, params.org_code!);
      if (!membership) return notFound("MEMBERSHIP_INVALID", `${params.user_id} is not a member of ${params.org_code}.`);
      const permission = d.permission(str(body.permission_id) ?? "");
      if (!permission) return notFound("PERMISSION_INVALID", "No permission has that id.");
      if (!membership.permissions.includes(permission.key)) membership.permissions.push(permission.key);
      return [200, OK];
    });

    this.route(
      "DELETE",
      "/api/v1/organizations/{org_code}/users/{user_id}/permissions/{permission_id}",
      "delete:organization_user_permissions",
      ({ params }) => {
        const membership = d.membership(params.user_id!, params.org_code!);
        const permission = d.permission(params.permission_id!);
        if (!membership || !permission) return notFound("PERMISSION_INVALID", "No such permission on that member.");
        membership.permissions = membership.permissions.filter((key) => key !== permission.key);
        return [200, OK];
      },
    );

    this.route("GET", "/api/v1/roles", "read:roles", ({ query }) => {
      const page = paginate(d.seed.roles, query);
      return [200, { ...OK, roles: page.items.map((r) => this.roleItem(r)), next_token: page.nextToken }];
    });

    this.route("POST", "/api/v1/roles", "create:roles", ({ body }) => {
      const key = str(body.key);
      if (!key) return [400, errors("KEY_REQUIRED", "A role needs a key.")];
      if (d.role(key)) return [409, errors("ROLE_ALREADY_EXISTS", `A role with the key ${key} already exists.`)];
      const role = d.ensureRole(key, {
        name: str(body.name) ?? undefined,
        description: str(body.description) ?? undefined,
        isDefault: body.is_default_role === true,
      });
      this.webhooks.emit("role.created", {
        role: { description: role.description ?? "", id: role.id, is_default_role: role.isDefault, key: role.key, name: role.name },
      });
      return [201, { ...OK, role: { id: role.id } }];
    });

    this.route("GET", "/api/v1/roles/{role_id}", "read:roles", ({ params }) => {
      const role = d.role(params.role_id!);
      return role ? [200, { ...OK, role: this.roleItem(role) }] : notFound("ROLE_INVALID", "No role has that id.");
    });

    this.route("DELETE", "/api/v1/roles/{role_id}", "delete:roles", ({ params }) => {
      const role = d.deleteRole(params.role_id!);
      if (!role) return notFound("ROLE_INVALID", "No role has that id.");
      this.webhooks.emit("role.deleted", { role: { id: role.id } });
      return [200, OK];
    });

    this.route("GET", "/api/v1/roles/{role_id}/permissions", "read:role_permissions", ({ params }) => {
      const role = d.role(params.role_id!);
      if (!role) return notFound("ROLE_INVALID", "No role has that id.");
      return [200, { ...OK, permissions: role.permissions.map((key) => this.permissionItem(d.ensurePermission(key))) }];
    });

    this.route("GET", "/api/v1/permissions", "read:permissions", ({ query }) => {
      const page = paginate(d.seed.permissions, query);
      return [200, { ...OK, permissions: page.items.map((p) => this.permissionItem(p)), next_token: page.nextToken }];
    });

    this.route("POST", "/api/v1/permissions", "create:permissions", ({ body }) => {
      const key = str(body.key);
      if (!key) return [400, errors("KEY_REQUIRED", "A permission needs a key.")];
      if (d.permission(key)) return [409, errors("PERMISSION_ALREADY_EXISTS", `A permission with the key ${key} already exists.`)];
      const permission = d.ensurePermission(key, { name: str(body.name) ?? undefined, description: str(body.description) ?? undefined });
      this.webhooks.emit("permission.created", {
        permission: { description: permission.description ?? "", id: permission.id, key: permission.key, name: permission.name },
      });
      return [201, OK];
    });

    this.route("DELETE", "/api/v1/permissions/{permission_id}", "delete:permissions", ({ params }) => {
      const permission = d.deletePermission(params.permission_id!);
      if (!permission) return notFound("PERMISSION_INVALID", "No permission has that id.");
      this.webhooks.emit("permission.deleted", { permission: { id: permission.id } });
      return [200, OK];
    });
  }

  private userListItem(user: KindeUser): Record<string, unknown> {
    const meta = this.directory.meta(user);
    return {
      id: user.id,
      provided_id: meta.providedId,
      email: user.email,
      phone: null,
      username: null,
      last_name: user.familyName,
      first_name: user.givenName,
      is_suspended: meta.isSuspended,
      picture: user.picture,
      total_sign_ins: meta.totalSignIns,
      failed_sign_ins: 0,
      last_signed_in: meta.lastSignedIn,
      created_on: meta.createdOn,
      organizations: this.organizationsOf(user),
      identities: user.email ? [{ type: "email", identity: user.email }] : [],
    };
  }

  private userDetail(user: KindeUser): Record<string, unknown> {
    const { email, ...rest } = this.userListItem(user);
    return { ...rest, preferred_email: email };
  }

  private organizationsOf(user: KindeUser): string[] {
    return this.directory.seed.memberships.filter((m) => m.userId === user.id).map((m) => m.organizationCode);
  }

  private organizationItem(org: KindeOrganization): Record<string, unknown> {
    const meta = this.directory.orgInfo(org);
    return {
      code: org.code,
      name: org.name,
      handle: meta.handle,
      is_default: false,
      external_id: meta.externalId,
      is_auto_membership_enabled: false,
    };
  }

  private organizationEvent(org: KindeOrganization): Record<string, unknown> {
    const meta = this.directory.orgInfo(org);
    return { code: org.code, external_id: meta.externalId, handle: meta.handle, name: org.name };
  }

  private roleItem(role: { id: string; key: string; name: string; description: string | null; isDefault: boolean }) {
    return { id: role.id, key: role.key, name: role.name, description: role.description, is_default_role: role.isDefault };
  }

  private permissionItem(permission: { id: string; key: string; name: string; description: string | null }) {
    return { id: permission.id, key: permission.key, name: permission.name, description: permission.description };
  }
}

function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; nextToken: string | null } {
  const size = Math.min(Math.max(Number(query.get("page_size") ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const token = query.get("next_token");
  const offset = token ? Number(Buffer.from(token, "base64url").toString("utf8")) || 0 : 0;
  const page = items.slice(offset, offset + size);
  const next = offset + size < items.length ? Buffer.from(String(offset + size)).toString("base64url") : null;
  return { items: page, nextToken: next };
}

function errors(code: string, message: string) {
  return { errors: [{ code, message }] };
}

function notFound(code: string, message: string): [number, unknown] {
  return [404, errors(code, message)];
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
