import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { ensureLocalCertificate } from "./certificate.js";
import type { AddressInfo } from "node:net";
import { TestkitError } from "./errors.js";
import { INVALID_TOKEN_KINDS, KindeTestkit } from "./testkit.js";
import { escapeHtml } from "./login-page.js";
import { featureFlagsFor, resolveSeed, seedScenario, type ResolvedSeed, type TestkitSeed } from "./seed.js";
import { AuthorizationServer } from "./oauth.js";
import { AccountApi } from "./account.js";
import { Directory } from "./directory.js";
import { ManagementApi } from "./management.js";
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
import { ActivityLog } from "./activity.js";
import { CoverageRecorder, DEFAULT_COVERAGE_DIRECTORY } from "./coverage.js";
import { renderDashboard } from "./dashboard.js";
import { loadSeedFile } from "./seed-file.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY_BYTES = 64 * 1024;
const JWKS_PATHS = new Set(["/.well-known/jwks", "/.well-known/jwks.json"]);

export interface StartKindeTestkitOptions {
  port?: number;
  host?: string;
  issuer?: string;
  audience?: string | string[];
  clientId?: string;
  /** A seed object, or the path of a JSON, YAML, JavaScript or TypeScript seed file. */
  seed?: TestkitSeed | string;
  allowPublic?: boolean;
  /** Write this run's authentication coverage to a folder when the testkit closes. */
  coverage?: boolean | { directory?: string };
  webhooks?: WebhookOptions;
  https?: boolean | { certDirectory?: string };
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
  directory: Directory;
  certificatePath: string | null;
  coverage: CoverageRecorder;
  activity: ActivityLog;
  /** Replaces the seed while the issuer runs. reset() returns to the new seed. */
  loadSeed(seed: TestkitSeed): void;
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
  const seedInput = typeof options.seed === "string" ? await loadSeedFile(options.seed) : (options.seed ?? {});
  const seed = resolveSeed(seedInput);

  const failures = new FailureInjector();
  let ready!: (value: Context) => void;
  const testkitReady = new Promise<Context>((resolve) => (ready = resolve));

  const listener: RequestListener = (req, res) => {
    testkitReady
      .then((context) => handle(req, res, context))
      .catch((error: unknown) => sendError(res, error));
  };
  const certificate = options.https
    ? ensureLocalCertificate(typeof options.https === "object" ? options.https.certDirectory : undefined)
    : null;
  const server = certificate
    ? createHttpsServer({ cert: certificate.cert, key: certificate.key }, listener)
    : createServer(listener);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4400, host, () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  // A wildcard bind is reached through localhost, so URLs and the default issuer use that.
  const urlHost = host === "::1" ? "[::1]" : host === "127.0.0.1" || host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const url = `${certificate ? "https" : "http"}://${urlHost}:${port}`;
  const testkit = await KindeTestkit.create({
    issuer: options.issuer ?? seedInput.issuer ?? url,
    audience: options.audience ?? seedInput.audience,
    clientId: options.clientId ?? seedInput.clientId,
  });
  const coverage = new CoverageRecorder();
  const activity = new ActivityLog();
  testkit.observe({
    accessToken(payload, invalid, token) {
      coverage.observeAccessToken(payload, invalid);
      const m2m = Array.isArray(payload.gty) && payload.gty.includes("client_credentials");
      activity.token(m2m ? "m2m" : "access", payload, invalid, token);
    },
    idToken(payload, token) {
      coverage.hit("identity.id-token");
      activity.token("id", payload, undefined, token);
    },
    anonymous() {
      coverage.hit("identity.anonymous");
    },
  });
  const observe = (id: string) => coverage.hit(id);
  const directory = new Directory(seed);
  const webhooks = new WebhookDispatcher(testkit, seed, seed.webhooks, options.webhooks);
  webhooks.observe = observe;
  const auth = new AuthorizationServer(testkit, seed, (type, user) => webhooks.emitForUser(type, user), directory, observe);
  const management = new ManagementApi(testkit, directory, webhooks);
  const account = new AccountApi(testkit, directory);
  const reset = () => {
    auth.reset();
    failures.clear();
    webhooks.reset();
    directory.restore();
  };
  const loadSeed = (input: TestkitSeed) => {
    const next = resolveSeed(input);
    directory.load(next);
    webhooks.replaceSeededEndpoints(next.webhooks);
    reset();
  };
  let closed = false;
  const close = () =>
    new Promise<void>((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      if (options.coverage) {
        coverage.write(typeof options.coverage === "object" ? options.coverage.directory : DEFAULT_COVERAGE_DIRECTORY);
      }
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  ready({ testkit, auth, seed, failures, webhooks, management, account, reset, coverage, activity, directory, loadSeed, close });

  return {
    url,
    issuer: testkit.issuer,
    discoveryUrl: `${url}/.well-known/openid-configuration`,
    jwksUri: `${url}/.well-known/jwks`,
    testkit,
    seed,
    failures,
    webhooks,
    directory,
    certificatePath: certificate?.certPath ?? null,
    coverage,
    activity,
    loadSeed,
    reset,
    close,
  };
}

interface Context {
  testkit: KindeTestkit;
  auth: AuthorizationServer;
  seed: ResolvedSeed;
  failures: FailureInjector;
  webhooks: WebhookDispatcher;
  management: ManagementApi;
  account: AccountApi;
  coverage: CoverageRecorder;
  activity: ActivityLog;
  directory: Directory;
  loadSeed(seed: TestkitSeed): void;
  reset(): void;
  close(): Promise<void>;
}

async function handle(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
  const { testkit, auth, seed, failures, webhooks, coverage } = context;
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;
  const method = req.method ?? "GET";
  const internal = pathname.startsWith("/testkit/") || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  let injected = false;
  if (!internal && pathname !== "/favicon.ico") {
    const started = Date.now();
    res.once("close", () => {
      context.activity.request({ method, path: pathname, query: url.searchParams, status: res.statusCode, durationMs: Date.now() - started, injected });
    });
  }

  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) return dashboard(req, res, url, context);

  if (!internal) {
    const failure = failures.take(method, pathname);
    if (failure) {
      injected = true;
      if (failure.hang) coverage.hit("outage.timeout");
      else if (failure.status === 429) coverage.hit("outage.rate-limit");
      else if (failure.status !== null) coverage.hit("outage.error");
      if (failure.delayMs > 0) coverage.hit("outage.slow");
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
  if (await context.management.handle(req, res, url, async () => (await readJson(req)) as Record<string, unknown>)) {
    if (res.statusCode === 401 || res.statusCode === 403) coverage.hit("api.management-denied");
    else if (res.statusCode < 400) coverage.hit(method === "GET" ? "api.management-read" : "api.management-write");
    return;
  }
  if (await context.account.handle(req, res, url)) {
    if (res.statusCode < 400) coverage.hit("api.account");
    return;
  }
  if (method === "GET" && pathname === "/testkit/portal") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Self-serve portal</title><body style="font:15px system-ui;padding:40px"><h1>Self-serve portal</h1><p>kinde-testkit does not emulate Kinde's self-serve portal. Your app linked here for <code>${escapeHtml(url.searchParams.get("subnav") ?? "profile")}</code>.</p>`,
    );
    return;
  }

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
    let accessToken: string;
    try {
      accessToken = await issueToken(testkit, seed, body);
    } catch (error) {
      if (error instanceof TestkitError && error.code === "SEED_NO_MEMBERSHIP") coverage.hit("organization.non-member");
      throw error;
    }
    return sendJson(res, 200, { access_token: accessToken, token_type: "Bearer" });
  }
  if (method === "GET" && pathname === "/testkit/coverage") {
    return sendJson(res, 200, { report: coverage.report(), snapshot: coverage.snapshot() });
  }
  if (method === "DELETE" && pathname === "/testkit/coverage") {
    coverage.reset();
    return sendJson(res, 200, { ok: true });
  }
  if (method === "GET" && pathname === "/testkit/requests") return sendJson(res, 200, context.activity.requests());
  if (method === "GET" && pathname === "/testkit/tokens") return sendJson(res, 200, context.activity.tokens());
  if (method === "POST" && pathname === "/testkit/seed") {
    const body = await readJson(req);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new TestkitError("SEED_INVALID", "The seed must be a JSON object.");
    }
    context.loadSeed(body as TestkitSeed);
    return sendJson(res, 200, {
      ok: true,
      users: seed.users.length,
      organizations: seed.organizations.length,
      memberships: seed.memberships.length,
    });
  }
  if (method === "POST" && pathname === "/testkit/stop") {
    sendJson(res, 200, { ok: true });
    res.once("finish", () => void context.close().catch(() => undefined));
    return;
  }
  return sendJson(res, 404, { error: "not_found", error_description: `${method} ${pathname} does not exist.` });
}

async function dashboard(req: IncomingMessage, res: ServerResponse, url: URL, context: Context): Promise<void> {
  const method = req.method ?? "GET";
  const { pathname } = url;
  if (method === "GET" && pathname === "/dashboard") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      renderDashboard({
        issuer: context.testkit.issuer,
        seed: context.seed,
        suspended: (id) => context.directory.isSuspended(id),
        signIns: (id) => {
          const user = context.directory.user(id);
          return user ? context.directory.meta(user).totalSignIns : 0;
        },
        tokens: context.activity.tokens(),
        requests: context.activity.requests(),
        deliveries: context.webhooks.deliveries(),
        endpoints: context.webhooks.listEndpoints(),
        failures: context.failures.list(),
        coverage: context.coverage.report(),
        webhookTypes: WEBHOOK_EVENT_TYPES,
        live: url.searchParams.has("live"),
        notice: url.searchParams.get("notice"),
      }),
    );
    return;
  }
  if (method !== "POST") return sendJson(res, 404, { error: "not_found", error_description: `${method} ${pathname} does not exist.` });
  // A page on another site could post a form here. Only accept forms from the dashboard itself.
  const origin = req.headers.origin;
  if (origin && origin !== "null" && new URL(origin).host !== req.headers.host) {
    return sendJson(res, 403, { error: "forbidden", error_description: "Dashboard actions only work from the dashboard page." });
  }
  const form = Object.fromEntries(new URLSearchParams(await readText(req)));
  let notice = "Done.";
  try {
    if (pathname === "/dashboard/reset") {
      context.reset();
      notice = "Reset sign-in sessions, failure rules, webhook deliveries, runtime endpoints and Management API changes.";
    } else if (pathname === "/dashboard/coverage/reset") {
      context.coverage.reset();
      notice = "Cleared coverage.";
    } else if (pathname === "/dashboard/failures/clear") {
      context.failures.clear();
      notice = "Removed every failure rule.";
    } else if (pathname === "/dashboard/failures") {
      const rule: FailureRule = { path: form.path ?? "" };
      if (form.method) rule.method = form.method;
      if (form.status) rule.status = Number(form.status);
      if (form.delayMs) rule.delayMs = Number(form.delayMs);
      if (form.times) rule.times = Number(form.times);
      if (form.hang) rule.hang = true;
      const added = context.failures.add(rule);
      notice = `Added ${added.id} for ${added.path}.`;
    } else if (pathname.startsWith("/dashboard/failures/") && pathname.endsWith("/remove")) {
      const id = decodeURIComponent(pathname.slice("/dashboard/failures/".length, -"/remove".length));
      notice = context.failures.remove(id) ? `Removed ${id}.` : `${id} was already gone.`;
    } else if (pathname === "/dashboard/webhooks") {
      const deliveries = await context.webhooks.send({
        type: form.type ?? "",
        user: form.user || undefined,
        invalid: (form.invalid || undefined) as SendWebhookOptions["invalid"],
        duplicate: form.duplicate ? Number(form.duplicate) : undefined,
      });
      const delivered = deliveries.filter((d) => d.delivered).length;
      notice = `Sent ${form.type}: ${delivered} of ${deliveries.length} deliveries got a 200.`;
    } else {
      return sendJson(res, 404, { error: "not_found", error_description: `POST ${pathname} does not exist.` });
    }
  } catch (error) {
    notice = (error as Error).message.replace(/\s+/g, " ").trim();
  }
  const anchor = pathname.includes("failures") ? "#failures" : pathname.includes("webhooks") ? "#webhooks" : pathname.includes("coverage") ? "#coverage" : "";
  res.writeHead(303, { location: `/dashboard?notice=${encodeURIComponent(notice)}${anchor}` });
  res.end();
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
    return (await testkit.tokenFor(scenario, {
      expiresIn,
      invalid,
      featureFlags: featureFlagsFor(seed, scenario.organization?.code ?? null),
    })) as string;
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
