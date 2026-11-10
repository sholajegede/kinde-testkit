import { randomUUID } from "node:crypto";
import {
  SignJWT,
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import { toKindeRole } from "./factories.js";
import { stableId } from "./ids.js";
import { toSeconds } from "./duration.js";
import type {
  AuthenticatedScenario,
  Duration,
  InvalidTokenKind,
  KindePrincipal,
  KindeTokenOptions,
  Scenario,
} from "./types.js";

export const DEFAULT_ISSUER = "http://localhost:4400";
export const DEFAULT_CLIENT_ID = "kinde_testkit_client";
export const DEFAULT_SCOPES = ["openid", "profile", "email", "offline"];

export const INVALID_TOKEN_KINDS: readonly InvalidTokenKind[] = [
  "expired",
  "wrong-issuer",
  "wrong-audience",
  "missing-subject",
  "missing-organization",
  "missing-permissions",
  "future-iat",
  "bad-signature",
  "unknown-key",
  "unsigned",
];

const WRONG_ISSUER = "https://wrong-issuer.kinde-testkit.test";
const WRONG_AUDIENCE = "https://wrong-audience.kinde-testkit.test";

export interface KindeTestkitOptions {
  issuer?: string;
  audience?: string | string[];
  clientId?: string;
  defaultExpiresIn?: Duration;
  now?: () => number;
}

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export type ScenarioTokenOverrides = Pick<
  KindeTokenOptions,
  "expiresIn" | "invalid" | "scopes" | "featureFlags" | "claims"
>;

export class KindeTestkit {
  readonly issuer: string;
  readonly audience: string[];
  readonly clientId: string;
  private readonly defaultExpiresIn: Duration;
  private readonly clock: () => number;
  private readonly signingKey: SigningKey;
  private strangerKey: Promise<SigningKey> | null = null;

  static async create(options: KindeTestkitOptions = {}): Promise<KindeTestkit> {
    return new KindeTestkit(options, await createSigningKey("kinde-testkit"));
  }

  private constructor(options: KindeTestkitOptions, signingKey: SigningKey) {
    this.issuer = trimSlash(options.issuer ?? DEFAULT_ISSUER);
    this.audience = toArray(options.audience);
    this.clientId = options.clientId ?? DEFAULT_CLIENT_ID;
    this.defaultExpiresIn = options.defaultExpiresIn ?? "1h";
    this.clock = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.signingKey = signingKey;
    warnIfRealKindeDomain(this.issuer);
  }

  get jwksUri(): string {
    return `${this.issuer}/.well-known/jwks`;
  }

  get keyId(): string {
    return this.signingKey.kid;
  }

  jwks(): { keys: JWK[] } {
    return { keys: [{ ...this.signingKey.publicJwk }] };
  }

  async token(options: KindeTokenOptions = {}): Promise<string> {
    const now = this.clock();
    const payload: JWTPayload & Record<string, unknown> = {
      aud: [...this.audience],
      azp: this.clientId,
      exp: now + toSeconds(options.expiresIn ?? this.defaultExpiresIn),
      iat: now,
      iss: this.issuer,
      jti: randomUUID(),
      permissions: [...(options.permissions ?? [])],
      roles: (options.roles ?? []).map(toKindeRole),
      scp: [...(options.scopes ?? DEFAULT_SCOPES)],
      sub: options.subject ?? stableId("kp", "default-test-user"),
    };
    if (options.organizationCode) payload.org_code = options.organizationCode;
    if (options.featureFlags) payload.feature_flags = options.featureFlags;
    Object.assign(payload, options.claims ?? {});
    return this.sign(applyInvalidClaims(payload, options.invalid, now), options.invalid);
  }

  async tokenFor(scenario: Scenario, overrides: ScenarioTokenOverrides = {}): Promise<string | null> {
    if (scenario.kind === "unauthenticated") return null;
    return this.token({
      subject: scenario.user.id,
      organizationCode: scenario.organization?.code ?? null,
      roles: scenario.roles,
      permissions: scenario.permissions,
      ...overrides,
      claims: { ...scenario.claims, ...(overrides.claims ?? {}) },
    });
  }

  async idTokenFor(scenario: Scenario, options: { expiresIn?: Duration } = {}): Promise<string | null> {
    if (scenario.kind === "unauthenticated") return null;
    const { user, organization } = scenario;
    const now = this.clock();
    const name = [user.givenName, user.familyName].filter(Boolean).join(" ");
    const payload: Record<string, unknown> = {
      aud: [this.clientId],
      auth_time: now,
      azp: this.clientId,
      email: user.email,
      email_verified: user.emailVerified,
      exp: now + toSeconds(options.expiresIn ?? this.defaultExpiresIn),
      family_name: user.familyName,
      given_name: user.givenName,
      iat: now,
      iss: this.issuer,
      jti: randomUUID(),
      name: name || null,
      org_codes: organization ? [organization.code] : [],
      picture: user.picture,
      sub: user.id,
      updated_at: now,
      ...user.claims,
    };
    return this.sign(payload);
  }

  async headersFor(scenario: Scenario, overrides: ScenarioTokenOverrides = {}): Promise<Record<string, string>> {
    const token = await this.tokenFor(scenario, overrides);
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  principalFor(scenario: Scenario): KindePrincipal | null {
    if (scenario.kind === "unauthenticated") return null;
    return scenarioPrincipal(scenario, this.issuer);
  }

  private async sign(payload: Record<string, unknown>, invalid?: InvalidTokenKind): Promise<string> {
    if (invalid === "unsigned") {
      const header = base64url.encode(JSON.stringify({ alg: "none", typ: "JWT" }));
      return `${header}.${base64url.encode(JSON.stringify(payload))}.`;
    }
    const key = invalid === "unknown-key" ? await this.stranger() : this.signingKey;
    const jwt = await new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
      .sign(key.privateKey);
    return invalid === "bad-signature" ? tamperSignature(jwt) : jwt;
  }

  private stranger(): Promise<SigningKey> {
    this.strangerKey ??= createSigningKey("kinde-testkit-unknown");
    return this.strangerKey;
  }
}

export function principalFromClaims(claims: Record<string, unknown>): KindePrincipal {
  const roles = Array.isArray(claims.roles)
    ? claims.roles.map((role) =>
        typeof role === "string" ? role : String((role as { key?: unknown }).key ?? ""),
      )
    : [];
  const permissions = Array.isArray(claims.permissions) ? claims.permissions.map(String) : [];
  return {
    subject: String(claims.sub ?? ""),
    issuer: String(claims.iss ?? ""),
    organization: typeof claims.org_code === "string" ? { code: claims.org_code } : null,
    roles: roles.filter(Boolean),
    permissions,
    claims: { ...claims },
  };
}

function scenarioPrincipal(scenario: AuthenticatedScenario, issuer: string): KindePrincipal {
  return {
    subject: scenario.user.id,
    issuer,
    organization: scenario.organization ? { code: scenario.organization.code } : null,
    roles: [...scenario.roles],
    permissions: [...scenario.permissions],
    claims: { ...scenario.claims },
  };
}

function applyInvalidClaims(
  payload: Record<string, unknown>,
  invalid: InvalidTokenKind | undefined,
  now: number,
): Record<string, unknown> {
  const next = { ...payload };
  switch (invalid) {
    case "expired":
      next.iat = now - 7200;
      next.exp = now - 3600;
      break;
    case "future-iat":
      next.iat = now + 3600;
      next.exp = now + 7200;
      break;
    case "wrong-issuer":
      next.iss = WRONG_ISSUER;
      break;
    case "wrong-audience":
      next.aud = [WRONG_AUDIENCE];
      break;
    case "missing-subject":
      delete next.sub;
      break;
    case "missing-organization":
      delete next.org_code;
      break;
    case "missing-permissions":
      next.permissions = [];
      break;
    default:
      break;
  }
  return next;
}

async function createSigningKey(prefix: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = `${prefix}-${(await calculateJwkThumbprint(jwk)).slice(0, 16)}`;
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

function tamperSignature(jwt: string): string {
  const [header, payload, signature] = jwt.split(".") as [string, string, string];
  const bytes = base64url.decode(signature);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return `${header}.${payload}.${base64url.encode(bytes)}`;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function warnIfRealKindeDomain(issuer: string): void {
  if (/^https:\/\/[^/]+\.kinde\.com$/i.test(issuer)) {
    process.emitWarning(
      `kinde-testkit issuer is set to ${issuer}, which looks like a real Kinde domain. ` +
        "Test tokens are signed with a local key and will never verify against Kinde's JWKS.",
      { code: "KINDE_TESTKIT_REAL_ISSUER" },
    );
  }
}

let defaultTestkit: Promise<KindeTestkit> | null = null;

export function getDefaultTestkit(): Promise<KindeTestkit> {
  defaultTestkit ??= KindeTestkit.create({
    issuer: process.env.KINDE_TESTKIT_ISSUER ?? DEFAULT_ISSUER,
    audience: process.env.KINDE_TESTKIT_AUDIENCE?.split(",").filter(Boolean),
  });
  return defaultTestkit;
}

export async function createKindeToken(options: KindeTokenOptions = {}): Promise<string> {
  return (await getDefaultTestkit()).token(options);
}
