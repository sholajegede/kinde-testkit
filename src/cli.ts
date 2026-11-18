import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { TestkitError } from "./errors.js";
import { startKindeTestkit } from "./server.js";
import type { TestkitSeed } from "./seed.js";
import { inspectToken, formatSpan, type Check } from "./inspect.js";
import { parseEnvFile, runDoctor } from "./doctor.js";
import { ensureLocalCertificate } from "./certificate.js";

const DEFAULT_URL = process.env.KINDE_TESTKIT_URL ?? "http://localhost:4400";
const DEFAULT_SEED_FILE = "kinde-testkit.json";

const HELP = `kinde-testkit: a local Kinde issuer for testing apps

Usage
  kinde-testkit start [options]          Start the local issuer
  kinde-testkit token [options]          Print a signed test access token
  kinde-testkit users [--json]           List seeded users
  kinde-testkit organizations [--json]   List seeded organizations
  kinde-testkit inspect [token]          Decode a token and check it (reads stdin when no token)
  kinde-testkit doctor [options]         Check your app's Kinde settings against the issuer
  kinde-testkit fail <path> [options]    Make an endpoint fail, slow down or hang
  kinde-testkit reset                    Clear sign-in sessions and failure rules
  kinde-testkit webhook <type> [options] Send a signed webhook event
  kinde-testkit cert [--dir <dir>]       Create the local HTTPS certificate and print its path

start
  --port <n>            Port to listen on (default 4400)
  --host <host>         Interface to bind (default 127.0.0.1)
  --issuer <url>        Issuer to put in tokens (default http://localhost:<port>)
  --audience <a,b>      Audience values for access tokens
  --client-id <id>      Value for azp
  --seed <file>         Seed file (default ./kinde-testkit.json when it exists)
  --allow-public        Allow binding to a non-loopback interface
  --webhook <url>       Send webhooks to this URL (repeatable)
  --https               Serve HTTPS with a local certificate (needed by @kinde/management-api-js)
  --cert-dir <dir>      Where to keep that certificate (default ./.kinde-testkit)

token
  --url <url>           Running issuer (default ${DEFAULT_URL})
  --user <id|email>     Seeded user
  --org <code>          Active organization
  --sub <id>            Subject, when not using a seeded user
  --permissions <a,b>   Override permissions
  --roles <a,b>         Override roles
  --expires-in <d>      Lifetime, such as 15m or 1h
  --invalid <kind>      expired, wrong-issuer, wrong-audience, missing-subject,
                        missing-organization, missing-permissions, future-iat,
                        bad-signature, unknown-key, unsigned
  --m2m                 Machine-to-machine token (client_credentials shape)
  --client-id <id>      M2M client ID, matched against seeded applications
  --scope <a,b>         M2M scopes requested
  --json                Print JSON instead of the raw token

inspect
  --url <url>           Also verify the issuer and signature against a running issuer
  --json                Print JSON

doctor
  --url <url>           Running issuer (default ${DEFAULT_URL})
  --env-file <file>     Read settings from this file (repeatable). Defaults to .env,
                        .env.local, .env.test and .env.test.local when they exist
  --json                Print JSON

fail <path>             An exact path such as /oauth2/token, or a prefix such as /oauth2/*
  --status <code>       Answer with this status, such as 429, 500 or 503
  --delay <ms>          Wait before answering
  --hang                Never answer
  --times <n>           Apply to the next n requests only
  --method <verb>       Only match this method
  --list                Show active rules
  --clear               Remove all rules

webhook <type>          Any event type, such as user.created or customer.plan_assigned
  --user <id|email>     Seeded user, for user.*, subscriber.* and access_request.*
  --org <code>          Organization, for organization.*
  --role <key>          Role, for role.*
  --permission <key>    Permission, for permission.*
  --data <json>         The event's data object. Needed for billing events
  --to <url>            Send to this URL instead of the configured endpoints
  --duplicate <n>       Send n copies with the same webhook-id
  --invalid <kind>      bad-signature, unknown-key, unsigned or stale
  --types               List the event types with built-in payloads
  --deliveries          Show the delivery log
`;

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "start":
      return start(rest);
    case "token":
      return token(rest);
    case "users":
      return list(rest, "users");
    case "organizations":
    case "orgs":
      return list(rest, "organizations");
    case "inspect":
      return inspect(rest);
    case "doctor":
      return doctor(rest);
    case "fail":
      return fail(rest);
    case "reset":
      return reset(rest);
    case "webhook":
    case "webhooks":
      return webhook(rest);
    case "cert":
      return cert(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      throw new TestkitError("INVALID_REQUEST", `Unknown command "${command}". Run kinde-testkit help.`);
  }
}

async function start(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      issuer: { type: "string" },
      audience: { type: "string" },
      "client-id": { type: "string" },
      seed: { type: "string" },
      "allow-public": { type: "boolean" },
      webhook: { type: "string", multiple: true },
      https: { type: "boolean" },
      "cert-dir": { type: "string" },
      json: { type: "boolean" },
    },
  });
  const seedPath = values.seed ?? (existsSync(DEFAULT_SEED_FILE) ? DEFAULT_SEED_FILE : undefined);
  const seed: TestkitSeed | undefined = seedPath ? readSeed(seedPath) : values.webhook ? {} : undefined;
  if (seed && values.webhook) seed.webhooks = [...(seed.webhooks ?? []), ...values.webhook.map((url) => ({ url }))];

  const running = await startKindeTestkit({
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    issuer: values.issuer,
    audience: values.audience ? csv(values.audience) : undefined,
    clientId: values["client-id"],
    seed,
    allowPublic: values["allow-public"],
    https: values.https ? { certDirectory: values["cert-dir"] } : undefined,
  });

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({
        url: running.url,
        issuer: running.issuer,
        discovery: running.discoveryUrl,
        jwks: running.jwksUri,
        users: running.seed.users.length,
        organizations: running.seed.organizations.length,
      })}\n`,
    );
  } else {
    process.stdout.write(
      [
        "",
        "Kinde Testkit",
        "",
        "Local issuer started.",
        "",
        `Issuer:        ${running.issuer}`,
        `Discovery:     ${running.discoveryUrl}`,
        `JWKS:          ${running.jwksUri}`,
        `Sign-in page:  ${running.url}/oauth2/auth`,
        `Token:         POST ${running.url}/testkit/token`,
        "",
        `Seed:          ${seedPath ? resolve(seedPath) : "none"}`,
        `Users:         ${running.seed.users.length}`,
        `Organizations: ${running.seed.organizations.length}`,
        `Webhooks:      ${running.webhooks.listEndpoints().map((e) => e.url).join(", ") || "none"}`,
        ...(running.certificatePath
          ? ["", "HTTPS uses a local certificate. Start Node processes that call the testkit with:", `  NODE_EXTRA_CA_CERTS=${running.certificatePath}`]
          : []),
        "",
        "Test tokens only. Press Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
  }

  const stop = () => {
    running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function token(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      user: { type: "string" },
      org: { type: "string" },
      sub: { type: "string" },
      permissions: { type: "string" },
      roles: { type: "string" },
      "expires-in": { type: "string" },
      invalid: { type: "string" },
      m2m: { type: "boolean" },
      "client-id": { type: "string" },
      scope: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const body: Record<string, unknown> = values.m2m
    ? {
        m2m: true,
        clientId: values["client-id"],
        organization: values.org,
        scopes: values.scope !== undefined ? csv(values.scope) : undefined,
        permissions: values.permissions !== undefined ? csv(values.permissions) : undefined,
        expiresIn: values["expires-in"],
        invalid: values.invalid,
      }
    : {
    user: values.user,
    organization: values.org,
    subject: values.sub,
    permissions: values.permissions !== undefined ? csv(values.permissions) : undefined,
    roles: values.roles !== undefined ? csv(values.roles) : undefined,
    expiresIn: values["expires-in"],
    invalid: values.invalid,
  };
  const result = await request(values.url ?? DEFAULT_URL, "/testkit/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const accessToken = (result as { access_token: string }).access_token;
  process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${accessToken}\n`);
}

async function inspect(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { url: { type: "string" }, json: { type: "boolean" } },
  });
  const raw = positionals[0] ?? (process.stdin.isTTY ? "" : await readStdin());
  const token = raw.trim().replace(/^Bearer\s+/i, "");
  if (!token) {
    throw new TestkitError("INVALID_REQUEST", "Pass a token, or pipe one in: kinde-testkit token | kinde-testkit inspect");
  }
  const result = await inspectToken(token, { issuerUrl: values.url });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const lines = [`${result.kind === "m2m" ? "Machine-to-machine access token" : result.kind === "id" ? "ID token" : result.kind === "access" ? "Access token" : "Token"}`, ""];
    if (result.payload) {
      const p = result.payload as Record<string, unknown>;
      const show = (label: string, value: unknown) => {
        if (value !== undefined) lines.push(`${label.padEnd(14)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
      };
      show("Subject", p.sub);
      show("Client", p.azp);
      show("Issuer", p.iss);
      show("Audience", p.aud);
      show("Organization", p.org_code ?? p.org_codes);
      show("Roles", Array.isArray(p.roles) ? p.roles.map((r) => (typeof r === "string" ? r : (r as { key?: string }).key)) : undefined);
      show("Permissions", p.permissions);
      show(result.kind === "m2m" ? "Requested" : "Scopes", p.scp);
      if (result.kind === "m2m") show("Granted", p.scope === "" ? "none" : p.scope);
      if (typeof p.exp === "number" && typeof p.iat === "number") show("Lifetime", formatSpan(p.exp - p.iat));
      lines.push("");
    }
    lines.push(...result.checks.map(formatCheck), "");
    process.stdout.write(lines.join("\n"));
  }
  if (result.checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

async function doctor(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      "env-file": { type: "string", multiple: true },
      json: { type: "boolean" },
    },
  });
  const files = values["env-file"] ?? [".env", ".env.local", ".env.test", ".env.test.local"].filter((file) => existsSync(file));
  const env: Record<string, string | undefined> = {};
  for (const file of files) {
    if (!existsSync(file)) throw new TestkitError("INVALID_REQUEST", `No env file at ${resolve(file)}.`);
    Object.assign(env, parseEnvFile(readFileSync(file, "utf8")));
  }
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("KINDE_") || key === "NODE_EXTRA_CA_CERTS") && value !== undefined) env[key] = value;
  }
  const report = await runDoctor({ url: values.url ?? DEFAULT_URL, env });
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...report, envFiles: files }, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "",
        "kinde-testkit doctor",
        "",
        `Settings read from: ${files.length > 0 ? files.join(", ") : "environment only"}`,
        "",
        ...report.checks.map(formatCheck),
        "",
        report.ok ? "Ready to test." : "Fix the failed checks above, then run doctor again.",
        "",
      ].join("\n"),
    );
  }
  if (!report.ok) process.exitCode = 1;
}

async function fail(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      status: { type: "string" },
      delay: { type: "string" },
      hang: { type: "boolean" },
      times: { type: "string" },
      method: { type: "string" },
      list: { type: "boolean" },
      clear: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const base = values.url ?? DEFAULT_URL;
  if (values.clear) {
    await request(base, "/testkit/failures", { method: "DELETE" });
    process.stdout.write("Removed all failure rules.\n");
    return;
  }
  if (values.list || positionals.length === 0) {
    const rules = (await request(base, "/testkit/failures")) as Array<Record<string, unknown>>;
    if (values.json) {
      process.stdout.write(`${JSON.stringify(rules)}\n`);
    } else if (rules.length === 0) {
      process.stdout.write("No failure rules.\n");
    } else {
      for (const rule of rules) process.stdout.write(`${describeRule(rule)}\n`);
    }
    return;
  }
  const rule = (await request(base, "/testkit/failures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: positionals[0],
      method: values.method,
      status: values.status !== undefined ? Number(values.status) : undefined,
      delayMs: values.delay !== undefined ? Number(values.delay) : undefined,
      hang: values.hang,
      times: values.times !== undefined ? Number(values.times) : undefined,
    }),
  })) as Record<string, unknown>;
  process.stdout.write(values.json ? `${JSON.stringify(rule)}\n` : `Added ${describeRule(rule)}\n`);
}

async function reset(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { url: { type: "string" } } });
  await request(values.url ?? DEFAULT_URL, "/testkit/reset", { method: "POST" });
  process.stdout.write("Cleared sign-in codes, refresh tokens, signed-up users and failure rules.\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function webhook(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      user: { type: "string" },
      org: { type: "string" },
      role: { type: "string" },
      permission: { type: "string" },
      data: { type: "string" },
      to: { type: "string" },
      duplicate: { type: "string" },
      invalid: { type: "string" },
      types: { type: "boolean" },
      deliveries: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const base = values.url ?? DEFAULT_URL;
  if (values.types) {
    const types = (await request(base, "/testkit/webhooks/types")) as { built_in: string[]; billing: string[] };
    process.stdout.write(
      values.json
        ? `${JSON.stringify(types)}\n`
        : `Built-in payloads:\n${types.built_in.map((t) => `  ${t}`).join("\n")}\n\nBilling events (pass --data):\n${types.billing.map((t) => `  ${t}`).join("\n")}\n`,
    );
    return;
  }
  if (values.deliveries || positionals.length === 0) {
    const log = (await request(base, "/testkit/webhooks/deliveries")) as Array<Record<string, unknown>>;
    if (values.json) {
      process.stdout.write(`${JSON.stringify(log)}\n`);
    } else if (log.length === 0) {
      process.stdout.write("No webhooks sent yet.\n");
    } else {
      for (const delivery of log) process.stdout.write(`${describeDelivery(delivery)}\n`);
    }
    return;
  }
  let data: unknown;
  if (values.data !== undefined) {
    try {
      data = JSON.parse(values.data);
    } catch {
      throw new TestkitError("INVALID_REQUEST", "--data must be a JSON object, for example '{\"customer_id\":\"c_1\"}'.");
    }
  }
  const deliveries = (await request(base, "/testkit/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: positionals[0],
      user: values.user,
      organization: values.org,
      role: values.role,
      permission: values.permission,
      data,
      to: values.to,
      duplicate: values.duplicate !== undefined ? Number(values.duplicate) : undefined,
      invalid: values.invalid,
    }),
  })) as Array<Record<string, unknown>>;
  if (values.json) {
    process.stdout.write(`${JSON.stringify(deliveries)}\n`);
    return;
  }
  for (const delivery of deliveries) process.stdout.write(`${describeDelivery(delivery)}\n`);
  if (deliveries.some((d) => !d.delivered)) process.exitCode = 1;
}

async function cert(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { dir: { type: "string" }, json: { type: "boolean" } } });
  const certificate = ensureLocalCertificate(values.dir);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ certPath: certificate.certPath, created: certificate.created })}\n`);
    return;
  }
  process.stdout.write(
    `${certificate.created ? "Created" : "Using"} ${certificate.certPath}\n\nTrust it in Node processes that call the testkit over HTTPS:\n  NODE_EXTRA_CA_CERTS=${certificate.certPath}\n`,
  );
}

function describeDelivery(delivery: Record<string, unknown>): string {
  const attempts = (delivery.attempts as Array<{ status: number | null; error: string | null }>) ?? [];
  const outcome = attempts.map((a) => (a.status === null ? "no answer" : String(a.status))).join(", ");
  const mark = delivery.delivered ? "✓" : "✗";
  return `${mark} ${String(delivery.type)} to ${String(delivery.url)} (${String(delivery.webhookId)}): ${outcome}`;
}

function describeRule(rule: Record<string, unknown>): string {
  const parts = [`${String(rule.id)}: ${rule.method ? `${String(rule.method)} ` : ""}${String(rule.path)}`];
  if (rule.status !== null) parts.push(`answers ${String(rule.status)}`);
  if (rule.delayMs) parts.push(`after ${String(rule.delayMs)}ms`);
  if (rule.hang) parts.push("never answers");
  parts.push(rule.remaining === null ? "until removed" : `for the next ${String(rule.remaining)} requests`);
  return parts.join(", ");
}

function formatCheck(check: Check): string {
  const mark = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
  return `${mark} ${check.name.padEnd(20)} ${check.detail}`;
}

async function list(args: string[], kind: "users" | "organizations"): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { url: { type: "string" }, json: { type: "boolean" } },
  });
  const rows = (await request(values.url ?? DEFAULT_URL, `/testkit/${kind}`)) as Array<
    Record<string, unknown>
  >;
  if (values.json) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`No seeded ${kind}.\n`);
    return;
  }
  for (const row of rows) {
    process.stdout.write(
      kind === "users"
        ? `${String(row.id).padEnd(24)} ${row.email ?? ""}\n`
        : `${String(row.code).padEnd(24)} ${row.name ?? ""}\n`,
    );
  }
}

async function request(base: string, path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, "")}${path}`, init);
  } catch {
    throw new TestkitError(
      "EMULATOR_UNREACHABLE",
      `Nothing is answering at ${base}. Start the issuer with "kinde-testkit start" or pass --url.`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const details = Array.isArray(body.details) ? (body.details as string[]) : [];
    const message = String(body.error_description ?? `Request failed with ${response.status}`);
    process.stderr.write(`${body.error ?? "ERROR"}\n\n${message}\n${details.map((d) => `  - ${d}\n`).join("")}`);
    process.exit(1);
  }
  return body;
}

function readSeed(path: string): TestkitSeed {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TestkitSeed;
  } catch (error) {
    throw new TestkitError("SEED_INVALID", `Could not read the seed file at ${resolve(path)}.`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function relaunchTrustingLocalCertificate(argv: string[]): boolean {
  if (process.env.KINDE_TESTKIT_TRUSTED || argv[0] === "start" || argv[0] === "cert") return false;
  const urlArg = argv.find((arg, i) => arg.startsWith("--url=") || argv[i - 1] === "--url");
  const target = urlArg?.replace(/^--url=/, "") ?? process.env.KINDE_TESTKIT_URL ?? "";
  const certPath = resolve(".kinde-testkit", "localhost-cert.pem");
  if (!target.startsWith("https://") || !existsSync(certPath)) return false;
  let trusted = certPath;
  const existing = process.env.NODE_EXTRA_CA_CERTS;
  if (existing && resolve(existing) !== certPath) {
    // Node reads one extra CA file, so keep the certificates the user already trusts.
    trusted = resolve(".kinde-testkit", "ca-bundle.pem");
    const current = existsSync(existing) ? readFileSync(existing, "utf8") : "";
    writeFileSync(trusted, `${current.trimEnd()}\n${readFileSync(certPath, "utf8")}`);
  }
  const result = spawnSync(process.execPath, [process.argv[1]!, ...argv], {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted, KINDE_TESTKIT_TRUSTED: "1" },
  });
  process.exit(result.status ?? 1);
}

if (!relaunchTrustingLocalCertificate(process.argv.slice(2))) main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof TestkitError) {
    process.stderr.write(`${error.toString()}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});
