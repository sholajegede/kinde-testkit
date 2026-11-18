import { randomUUID } from "node:crypto";
import {
  SignJWT,
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  jwtVerify,
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
export const DEFAULT_M2M_CLIENT_ID = "kinde_testkit_m2m";
export const DEFAULT_SCOPES = ["openid", "profile", "email", "offline"];
export const DEFAULT_AUTH_METHODS = ["email"];

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
  accessTokenExpiresIn?: Duration;
  idTokenExpiresIn?: Duration;
  now?: () => number;
}

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
}

export type ScenarioTokenOverrides = Pick<
  KindeTokenOptions,
  | "expiresIn"
  | "invalid"
  | "scopes"
  | "featureFlags"
  | "claims"
  | "authMethods"
  | "authTime"
  | "clientId"
  | "audience"
>;

export interface M2MTokenOptions {
  clientId?: string;
  organizationCode?: string | null;
  scopes?: string[];
  grantedScopes?: string[];
  audience?: string[];
  permissions?: string[];
  claims?: Record<string, unknown>;
  expiresIn?: Duration;
  invalid?: InvalidTokenKind;
}

export interface IdTokenOptions {
  expiresIn?: Duration;
  authMethods?: string[];
  authTime?: number;
  clientId?: string;
  nonce?: string;
}

/** Receives every token the testkit signs, for coverage and the dashboard. */
export interface TokenObserver {
  accessToken?(payload: Record<string, unknown>, invalid: InvalidTokenKind | undefined, token: string): void;
  idToken?(payload: Record<string, unknown>, token: string): void;
  anonymous?(): void;
}

export class KindeTestkit {
  private observers: TokenObserver[] = [];

  /** Calls the observer for every token signed from now on. Returns a function that stops it. */
  observe(observer: TokenObserver): () => void {
    this.observers.push(observer);
    return () => {
      this.observers = this.observers.filter((o) => o !== observer);
    };
  }

  private async signAccess(payload: Record<string, unknown>, invalid: InvalidTokenKind | undefined, now: number): Promise<string> {
    const final = applyInvalidClaims(payload, invalid, now);
    const token = await this.sign(final, invalid);
    for (const observer of this.observers) observer.accessToken?.(final, invalid, token);
    return token;
  }

  readonly issuer: string;
  readonly audience: string[];
  readonly clientId: string;
  private readonly accessTokenExpiresIn: Duration;
  private readonly idTokenExpiresIn: Duration;
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
    this.accessTokenExpiresIn = options.accessTokenExpiresIn ?? "24h";
    this.idTokenExpiresIn = options.idTokenExpiresIn ?? "1h";
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

  get accessTokenLifetime(): number {
    return toSeconds(this.accessTokenExpiresIn);
  }

  async verify(token: string): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.signingKey.publicKey, {
      issuer: this.issuer,
      algorithms: ["RS256"],
    });
    return payload;
  }

  jwks(): { keys: JWK[] } {
    return { keys: [{ ...this.signingKey.publicJwk }] };
  }

  async token(options: KindeTokenOptions = {}): Promise<string> {
    const now = this.clock();
    const payload: JWTPayload & Record<string, unknown> = {
      amr: [...(options.authMethods ?? DEFAULT_AUTH_METHODS)],
      aud: [...(options.audience ?? this.audience)],
      auth_time: options.authTime ?? now,
      azp: options.clientId ?? this.clientId,
      exp: now + toSeconds(options.expiresIn ?? this.accessTokenExpiresIn),
      iat: now,
      iss: this.issuer,
      jti: randomUUID(),
      scp: [...(options.scopes ?? DEFAULT_SCOPES)],
      sub: options.subject ?? stableId("kp", "default-test-user"),
    };
    if (options.permissions !== undefined) payload.permissions = [...options.permissions];
    if (options.roles !== undefined) payload.roles = options.roles.map(toKindeRole);
    if (options.organizationCode) payload.org_code = options.organizationCode;
    if (options.featureFlags) payload.feature_flags = options.featureFlags;
    Object.assign(payload, options.claims ?? {});
    return this.signAccess(payload, options.invalid, now);
  }

  async m2mToken(options: M2MTokenOptions = {}): Promise<string> {
    const now = this.clock();
    const requested = [...(options.scopes ?? [])];
    const granted = [...(options.grantedScopes ?? requested)];
    const payload: JWTPayload & Record<string, unknown> = {
      aud: [...(options.audience ?? this.audience)],
      azp: options.clientId ?? DEFAULT_M2M_CLIENT_ID,
      exp: now + toSeconds(options.expiresIn ?? this.accessTokenExpiresIn),
      gty: ["client_credentials"],
      iat: now,
      iss: this.issuer,
      jti: randomUUID(),
      scope: granted.join(" "),
      scp: requested,
      v: "2",
    };
    if (options.organizationCode) payload.org_code = options.organizationCode;
    if (options.permissions !== undefined) payload.permissions = [...options.permissions];
    Object.assign(payload, options.claims ?? {});
    return this.signAccess(payload, options.invalid, now);
  }

  async tokenFor(scenario: Scenario, overrides: ScenarioTokenOverrides = {}): Promise<string | null> {
    if (scenario.kind === "unauthenticated") {
      for (const observer of this.observers) observer.anonymous?.();
      return null;
    }
    return this.token({
      subject: scenario.user.id,
      organizationCode: scenario.organization?.code ?? null,
      roles: scenario.roles.length > 0 ? scenario.roles : undefined,
      permissions: scenario.permissions.length > 0 ? scenario.permissions : undefined,
      ...overrides,
      claims: { ...scenario.claims, ...(overrides.claims ?? {}) },
    });
  }

  async idTokenFor(scenario: Scenario, options: IdTokenOptions = {}): Promise<string | null> {
    if (scenario.kind === "unauthenticated") return null;
    const { user, organization } = scenario;
    const now = this.clock();
    const authTime = options.authTime ?? now;
    const name = [user.givenName, user.familyName].filter(Boolean).join(" ");
    const clientId = options.clientId ?? this.clientId;
    const payload: Record<string, unknown> = {
      amr: [...(options.authMethods ?? DEFAULT_AUTH_METHODS)],
      aud: [clientId],
      auth_time: authTime,
      azp: clientId,
      email: user.email,
      email_verified: user.emailVerified,
      exp: now + toSeconds(options.expiresIn ?? this.idTokenExpiresIn),
      family_name: user.familyName,
      given_name: user.givenName,
      iat: now,
      iss: this.issuer,
      jti: randomUUID(),
      name: name || null,
      nonce: options.nonce,
      org_codes: organization ? [organization.code] : undefined,
      picture: user.picture,
      rat: authTime,
      sub: user.id,
      updated_at: now,
      ...user.claims,
    };
    for (const key of Object.keys(payload)) {
      if (payload[key] === null || payload[key] === undefined) delete payload[key];
    }
    const token = await this.sign(payload);
    for (const observer of this.observers) observer.idToken?.(payload, token);
    return token;
  }

  async headersFor(scenario: Scenario, overrides: ScenarioTokenOverrides = {}): Promise<Record<string, string>> {
    const token = await this.tokenFor(scenario, overrides);
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  principalFor(scenario: Scenario): KindePrincipal | null {
    if (scenario.kind === "unauthenticated") return null;
    return scenarioPrincipal(scenario, this.issuer);
  }

  async signPayload(
    payload: Record<string, unknown>,
    invalid?: "bad-signature" | "unknown-key" | "unsigned",
  ): Promise<string> {
    return this.sign(payload, invalid);
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
  const machine = Array.isArray(claims.gty) && claims.gty.includes("client_credentials");
  return {
    type: machine ? "machine" : "user",
    subject: String((machine ? claims.azp : claims.sub) ?? ""),
    issuer: String(claims.iss ?? ""),
    organization: typeof claims.org_code === "string" ? { code: claims.org_code } : null,
    roles: roles.filter(Boolean),
    permissions,
    claims: { ...claims },
  };
}

function scenarioPrincipal(scenario: AuthenticatedScenario, issuer: string): KindePrincipal {
  return {
    type: "user",
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
  return { kid, privateKey, publicKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
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
