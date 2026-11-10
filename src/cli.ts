import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { TestkitError } from "./errors.js";
import { startKindeTestkit } from "./server.js";
import type { TestkitSeed } from "./seed.js";

const DEFAULT_URL = process.env.KINDE_TESTKIT_URL ?? "http://localhost:4400";
const DEFAULT_SEED_FILE = "kinde-testkit.json";

const HELP = `kinde-testkit: a local issuer for testing Kinde-authenticated apps

Usage
  kinde-testkit start [options]          Start the local issuer
  kinde-testkit token [options]          Print a signed test access token
  kinde-testkit users [--json]           List seeded users
  kinde-testkit organizations [--json]   List seeded organizations

start
  --port <n>            Port to listen on (default 4400)
  --host <host>         Interface to bind (default 127.0.0.1)
  --issuer <url>        Issuer to put in tokens (default http://localhost:<port>)
  --audience <a,b>      Audience values for access tokens
  --client-id <id>      Value for azp
  --seed <file>         Seed file (default ./kinde-testkit.json when it exists)
  --allow-public        Allow binding to a non-loopback interface

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
  --json                Print JSON instead of the raw token
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
      json: { type: "boolean" },
    },
  });
  const seedPath = values.seed ?? (existsSync(DEFAULT_SEED_FILE) ? DEFAULT_SEED_FILE : undefined);
  const seed = seedPath ? readSeed(seedPath) : undefined;

  const running = await startKindeTestkit({
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    issuer: values.issuer,
    audience: values.audience ? csv(values.audience) : undefined,
    clientId: values["client-id"],
    seed,
    allowPublic: values["allow-public"],
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
        `Token:         POST ${running.url}/testkit/token`,
        "",
        `Seed:          ${seedPath ? resolve(seedPath) : "none"}`,
        `Users:         ${running.seed.users.length}`,
        `Organizations: ${running.seed.organizations.length}`,
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
      json: { type: "boolean" },
    },
  });
  const body: Record<string, unknown> = {
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

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof TestkitError) {
    process.stderr.write(`${error.toString()}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});
