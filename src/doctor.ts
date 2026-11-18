import type { Check } from "./inspect.js";

const SECRET_FORMAT = /^[a-zA-Z0-9]{40,60}$/;

export interface DoctorReport {
  url: string;
  checks: Check[];
  ok: boolean;
}

export async function runDoctor(options: { url: string; env: Record<string, string | undefined> }): Promise<DoctorReport> {
  const url = options.url.replace(/\/+$/, "");
  const checks: Check[] = [];
  let issuer: string | null = null;

  try {
    const health = (await (await fetch(`${url}/testkit/health`)).json()) as { issuer?: string };
    issuer = health.issuer ?? null;
    checks.push({ name: "Issuer running", status: "pass", detail: `${url} answers, issuer ${issuer}.` });
  } catch {
    checks.push({ name: "Issuer running", status: "fail", detail: `Nothing answers at ${url}. Start it with "kinde-testkit start".` });
  }

  if (issuer) {
    try {
      const discovery = (await (await fetch(`${url}/.well-known/openid-configuration`)).json()) as { issuer?: string };
      checks.push(
        discovery.issuer === issuer
          ? { name: "Discovery", status: "pass", detail: "The discovery document names the same issuer." }
          : { name: "Discovery", status: "fail", detail: `Discovery says ${String(discovery.issuer)}, health says ${issuer}.` },
      );
    } catch {
      checks.push({ name: "Discovery", status: "fail", detail: "Could not read /.well-known/openid-configuration." });
    }
    try {
      const jwks = (await (await fetch(`${url}/.well-known/jwks.json`)).json()) as { keys?: Array<{ kty?: string; use?: string }> };
      const usable = (jwks.keys ?? []).filter((key) => key.kty === "RSA" && key.use === "sig");
      checks.push(
        usable.length > 0
          ? { name: "JWKS", status: "pass", detail: `${usable.length} RS256 signing key at /.well-known/jwks.json.` }
          : { name: "JWKS", status: "fail", detail: "No RSA signing key at /.well-known/jwks.json." },
      );
    } catch {
      checks.push({ name: "JWKS", status: "fail", detail: "Could not read /.well-known/jwks.json." });
    }
    try {
      const users = (await (await fetch(`${url}/testkit/users`)).json()) as unknown[];
      checks.push(
        users.length > 0
          ? { name: "Seed", status: "pass", detail: `${users.length} seeded ${users.length === 1 ? "user" : "users"}.` }
          : { name: "Seed", status: "warn", detail: "No seeded users. The sign-in page still accepts any email, but those users have no organization." },
      );
    } catch {
      checks.push({ name: "Seed", status: "warn", detail: "Could not read /testkit/users." });
    }
  }

  const env = options.env;
  const configured = env.KINDE_ISSUER_URL?.trim().replace(/\/+$/, "");
  if (!configured) {
    checks.push({ name: "KINDE_ISSUER_URL", status: "fail", detail: "Not set. Set it to the testkit's issuer for test runs." });
  } else if (/\.kinde\.com$/i.test(new URL(configured, "http://x").hostname)) {
    checks.push({ name: "KINDE_ISSUER_URL", status: "fail", detail: `${configured} is a real Kinde domain. Tests would sign in against Kinde, not the testkit.` });
  } else if (issuer && configured !== issuer) {
    checks.push({ name: "KINDE_ISSUER_URL", status: "fail", detail: `${configured} does not match the testkit issuer ${issuer}. Token checks compare iss exactly.` });
  } else {
    checks.push({ name: "KINDE_ISSUER_URL", status: "pass", detail: `${configured}.` });
  }

  checks.push(
    env.KINDE_CLIENT_ID
      ? { name: "KINDE_CLIENT_ID", status: "pass", detail: "Set. The testkit accepts any client ID." }
      : { name: "KINDE_CLIENT_ID", status: "fail", detail: "Not set. Kinde's SDKs refuse to start without it." },
  );

  const secret = env.KINDE_CLIENT_SECRET;
  if (!secret) {
    checks.push({ name: "KINDE_CLIENT_SECRET", status: "warn", detail: "Not set. Server-side SDKs, such as the Next.js SDK, need it." });
  } else if (!SECRET_FORMAT.test(secret)) {
    checks.push({ name: "KINDE_CLIENT_SECRET", status: "fail", detail: "The Next.js SDK only accepts 40 to 60 letters and digits." });
  } else {
    checks.push({ name: "KINDE_CLIENT_SECRET", status: "pass", detail: "Set, in the format Kinde's SDKs accept." });
  }

  const site = env.KINDE_SITE_URL;
  if (!site) {
    checks.push({ name: "KINDE_SITE_URL", status: "warn", detail: "Not set. The Next.js SDK builds its callback URL from it." });
  } else if (!/^https?:\/\//.test(site)) {
    checks.push({ name: "KINDE_SITE_URL", status: "fail", detail: `${site} is not an http or https URL.` });
  } else {
    checks.push({ name: "KINDE_SITE_URL", status: "pass", detail: `${site}.` });
  }

  return { url, checks, ok: checks.every((check) => check.status !== "fail") };
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]!] = value;
  }
  return values;
}
