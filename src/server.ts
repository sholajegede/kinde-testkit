import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TestkitError } from "./errors.js";
import { INVALID_TOKEN_KINDS, KindeTestkit } from "./testkit.js";
import { resolveSeed, seedScenario, type ResolvedSeed, type TestkitSeed } from "./seed.js";
import { AuthorizationServer } from "./oauth.js";
import { FailureInjector, failureBody, type FailureRule } from "./failures.js";
import {
  BILLING_EVENT_TYPES,
  WEBHOOK_EVENT_TYPES,
  WebhookDispatcher,
  type SendWebhookOptions,
  type WebhookEndpointInput,
  type WebhookOptions,
} from "./webhooks.js";
import type { Duration, InvalidTokenKind, KindeTokenOptions } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY_BYTES = 64 * 1024;
const JWKS_PATHS = new Set(["/.well-known/jwks", "/.well-known/jwks.json"]);

export interface StartKindeTestkitOptions {
  port?: number;
  host?: string;
  issuer?: string;
  audience?: string | string[];
  clientId?: string;
  seed?: TestkitSeed;
  allowPublic?: boolean;
  webhooks?: WebhookOptions;
}

export interface RunningKindeTestkit {
  url: string;
  issuer: string;
  discoveryUrl: string;
  jwksUri: string;
  testkit: KindeTestkit;
  seed: ResolvedSeed;
  failures: FailureInjector;
  webhooks: WebhookDispatcher;
  reset(): void;
  close(): Promise<void>;
}

export async function startKindeTestkit(
  options: StartKindeTestkitOptions = {},
): Promise<RunningKindeTestkit> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) && !options.allowPublic) {
    throw new TestkitError(
      "PUBLIC_BIND_REFUSED",
      `kinde-testkit will not listen on ${host}. It signs tokens for any identity, so it stays on localhost unless you pass --allow-public (allowPublic: true in code).`,
    );
  }
  const seed = resolveSeed(options.seed ?? {});

  const failures = new FailureInjector();
  let ready!: (value: Context) => void;
  const testkitReady = new Promise<Context>((resolve) => (ready = resolve));

  const server = createServer((req, res) => {
    testkitReady
      .then((context) => handle(req, res, context))
      .catch((error: unknown) => sendError(res, error));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4400, host, () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  const urlHost = host === "::1" ? "[::1]" : host === "127.0.0.1" ? "localhost" : host;
  const url = `http://${urlHost}:${port}`;
  const testkit = await KindeTestkit.create({
    issuer: options.issuer ?? options.seed?.issuer ?? url,
    audience: options.audience ?? options.seed?.audience,
    clientId: options.clientId ?? options.seed?.clientId,
  });
  const webhooks = new WebhookDispatcher(testkit, seed, seed.webhooks, options.webhooks);
  const auth = new AuthorizationServer(testkit, seed, (type, user) => webhooks.emitForUser(type, user));
  const reset = () => {
    auth.reset();
    failures.clear();
    webhooks.reset();
  };
  ready({ testkit, auth, seed, failures, webhooks, reset });

  return {
    url,
    issuer: testkit.issuer,
    discoveryUrl: `${url}/.well-known/openid-configuration`,
    jwksUri: `${url}/.well-known/jwks`,
    testkit,
    seed,
    failures,
    webhooks,
    reset,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

interface Context {
  testkit: KindeTestkit;
  auth: AuthorizationServer;
  seed: ResolvedSeed;
  failures: FailureInjector;
  webhooks: WebhookDispatcher;
  reset(): void;
}

async function handle(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
  const { testkit, auth, seed, failures, webhooks } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (!pathname.startsWith("/testkit/")) {
    const failure = failures.take(method, pathname);
    if (failure) {
      if (failure.hang) return;
      if (failure.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
      if (failure.status !== null) {
        const headers: Record<string, string> = {};
        if (failure.status === 429 || failure.status === 503) headers["retry-after"] = String(failure.retryAfter);
        return sendJson(res, failure.status, failureBody(failure.status), headers);
      }
    }
  }

  if (await auth.handle(req, res, url, () => readForm(req))) return;

  if (method === "GET" && pathname === "/.well-known/openid-configuration") {
    return sendJson(res, 200, discovery(testkit));
  }
  if (method === "GET" && JWKS_PATHS.has(pathname)) {
    return sendJson(res, 200, testkit.jwks());
  }
  if (method === "GET" && pathname === "/testkit/health") {
    return sendJson(res, 200, { ok: true, issuer: testkit.issuer, kid: testkit.keyId });
  }
  if (method === "GET" && pathname === "/testkit/users") return sendJson(res, 200, seed.users);
  if (method === "GET" && pathname === "/testkit/organizations") {
    return sendJson(res, 200, seed.organizations);
  }
  if (method === "GET" && pathname === "/testkit/memberships") {
    return sendJson(res, 200, seed.memberships);
  }
  if (method === "GET" && pathname === "/testkit/failures") return sendJson(res, 200, failures.list());
  if (method === "POST" && pathname === "/testkit/failures") {
    return sendJson(res, 201, failures.add((await readJson(req)) as FailureRule));
  }
  if (method === "DELETE" && pathname === "/testkit/failures") {
    failures.clear();
    return sendJson(res, 200, { ok: true });
  }
  if (method === "DELETE" && pathname.startsWith("/testkit/failures/")) {
    const removed = failures.remove(decodeURIComponent(pathname.slice("/testkit/failures/".length)));
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }
  if (method === "POST" && pathname === "/testkit/webhooks") {
    return sendJson(res, 200, await webhooks.send((await readJson(req)) as SendWebhookOptions));
  }
  if (method === "GET" && pathname === "/testkit/webhooks/types") {
    return sendJson(res, 200, { built_in: WEBHOOK_EVENT_TYPES, billing: BILLING_EVENT_TYPES });
  }
  if (method === "GET" && pathname === "/testkit/webhooks/deliveries") return sendJson(res, 200, webhooks.deliveries());
  if (method === "GET" && pathname === "/testkit/webhooks/endpoints") return sendJson(res, 200, webhooks.listEndpoints());
  if (method === "POST" && pathname === "/testkit/webhooks/endpoints") {
    return sendJson(res, 201, webhooks.addEndpoint((await readJson(req)) as WebhookEndpointInput));
  }
  if (method === "DELETE" && pathname.startsWith("/testkit/webhooks/endpoints/")) {
    const removed = webhooks.removeEndpoint(decodeURIComponent(pathname.slice("/testkit/webhooks/endpoints/".length)));
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }
  if (method === "POST" && pathname === "/testkit/reset") {
    context.reset();
    return sendJson(res, 200, { ok: true });
  }
  if (method === "POST" && pathname === "/testkit/token") {
    const body = await readJson(req);
    const accessToken = await issueToken(testkit, seed, body);
    return sendJson(res, 200, { access_token: accessToken, token_type: "Bearer" });
  }
  return sendJson(res, 404, { error: "not_found", error_description: `${method} ${pathname} does not exist.` });
}

function discovery(testkit: KindeTestkit): Record<string, unknown> {
  const base = testkit.issuer;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth2/auth`,
    token_endpoint: `${base}/oauth2/token`,
    userinfo_endpoint: `${base}/oauth2/v2/user_profile`,
    end_session_endpoint: `${base}/logout`,
    revocation_endpoint: `${base}/oauth2/revoke`,
    jwks_uri: `${base}/.well-known/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email", "offline"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    claims_supported: ["aud", "exp", "iat", "iss", "sub", "org_code", "permissions", "roles", "scp"],
  };
}

async function issueToken(testkit: KindeTestkit, seed: ResolvedSeed, body: unknown): Promise<string> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TestkitError("INVALID_REQUEST", "The request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const invalid = optionalString(input, "invalid") as InvalidTokenKind | undefined;
  if (invalid !== undefined && !INVALID_TOKEN_KINDS.includes(invalid)) {
    throw new TestkitError("INVALID_REQUEST", `"${invalid}" is not a known invalid token kind.`, [
      `Use one of: ${INVALID_TOKEN_KINDS.join(", ")}`,
    ]);
  }
  const expiresIn = input.expiresIn as Duration | undefined;
  if (input.m2m === true) {
    const clientId = optionalString(input, "clientId");
    const app = clientId ? seed.applications.find((a) => a.clientId === clientId) : undefined;
    const scopes = optionalStrings(input, "scopes") ?? [];
    return testkit.m2mToken({
      clientId,
      organizationCode: optionalString(input, "organizationCode") ?? optionalString(input, "organization") ?? app?.organizationCode ?? null,
      scopes,
      grantedScopes: app?.scopes ? scopes.filter((scope) => app.scopes!.includes(scope)) : scopes,
      audience: optionalStrings(input, "audience") ?? app?.audience ?? undefined,
      permissions: optionalStrings(input, "permissions") ?? app?.permissions ?? undefined,
      expiresIn,
      invalid,
    });
  }
  const permissions = optionalStrings(input, "permissions");
  const roles = optionalStrings(input, "roles");
  const userRef = optionalString(input, "user");

  if (userRef) {
    const scenario = seedScenario(seed, {
      user: userRef,
      organization: optionalString(input, "organization") ?? null,
    });
    if (permissions) scenario.permissions = permissions;
    if (roles) scenario.roles = roles;
    return (await testkit.tokenFor(scenario, { expiresIn, invalid })) as string;
  }

  const options: KindeTokenOptions = {
    subject: optionalString(input, "subject"),
    organizationCode: optionalString(input, "organizationCode") ?? optionalString(input, "organization") ?? null,
    permissions,
    roles,
    scopes: optionalStrings(input, "scopes"),
    expiresIn,
    invalid,
  };
  if (typeof input.claims === "object" && input.claims !== null) {
    options.claims = input.claims as Record<string, unknown>;
  }
  return testkit.token(options);
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new TestkitError("INVALID_REQUEST", `"${field}" must be a string.`);
  }
  return value;
}

function optionalStrings(input: Record<string, unknown>, field: string): string[] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TestkitError("INVALID_REQUEST", `"${field}" must be a list of strings.`);
  }
  return value as string[];
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const text = await readText(req);
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(text || "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    } catch {
      throw new TestkitError("INVALID_REQUEST", "The request body is not valid JSON.");
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readText(req);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new TestkitError("INVALID_REQUEST", "The request body is not valid JSON.");
  }
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new TestkitError("INVALID_REQUEST", "The request body is larger than 64 KB.");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof TestkitError) {
    sendJson(res, 400, { error: error.code, error_description: error.message, details: error.details });
    return;
  }
  sendJson(res, 500, {
    error: "server_error",
    error_description: error instanceof Error ? error.message : String(error),
  });
}
