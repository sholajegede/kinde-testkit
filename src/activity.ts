import type { InvalidTokenKind } from "./types.js";

const LIMIT = 200;
const SECRET_PARAMS = ["code", "client_secret", "refresh_token", "code_verifier", "token"];

export interface RequestEntry {
  at: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  injected: boolean;
}

export interface TokenEntry {
  at: string;
  kind: "access" | "m2m" | "id";
  subject: string | null;
  organization: string | null;
  permissions: string[];
  roles: string[];
  invalid: InvalidTokenKind | null;
  expiresAt: string | null;
  claims: Record<string, unknown>;
  token: string;
}

/** Keeps the latest requests and tokens for the dashboard and `kinde-testkit inspect --requests`. */
export class ActivityLog {
  private requestLog: RequestEntry[] = [];
  private tokenLog: TokenEntry[] = [];

  request(entry: Omit<RequestEntry, "at" | "path"> & { path: string; query: URLSearchParams }): void {
    const query = new URLSearchParams(entry.query);
    for (const name of SECRET_PARAMS) if (query.has(name)) query.set(name, "…");
    const search = query.toString();
    push(this.requestLog, {
      at: new Date().toISOString(),
      method: entry.method,
      path: search ? `${entry.path}?${search}` : entry.path,
      status: entry.status,
      durationMs: entry.durationMs,
      injected: entry.injected,
    });
  }

  token(kind: TokenEntry["kind"], claims: Record<string, unknown>, invalid: InvalidTokenKind | undefined, token: string): void {
    const roles = Array.isArray(claims.roles)
      ? (claims.roles as Array<{ key?: string } | string>).map((r) => (typeof r === "string" ? r : (r.key ?? "")))
      : [];
    push(this.tokenLog, {
      at: new Date().toISOString(),
      kind,
      subject: typeof claims.sub === "string" ? claims.sub : typeof claims.azp === "string" && kind === "m2m" ? claims.azp : null,
      organization: typeof claims.org_code === "string" ? claims.org_code : null,
      permissions: Array.isArray(claims.permissions) ? (claims.permissions as string[]) : [],
      roles,
      invalid: invalid ?? null,
      expiresAt: typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : null,
      claims,
      token,
    });
  }

  requests(): RequestEntry[] {
    return [...this.requestLog];
  }

  tokens(): TokenEntry[] {
    return [...this.tokenLog];
  }

  reset(): void {
    this.requestLog = [];
    this.tokenLog = [];
  }
}

function push<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
}
