import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startKindeTestkit, type RunningKindeTestkit } from "../src/index.js";

let running: RunningKindeTestkit;
const certDirectory = mkdtempSync(join(tmpdir(), "kinde-testkit-cert-"));

beforeAll(async () => {
  running = await startKindeTestkit({
    port: 0,
    https: { certDirectory },
    seed: { users: [{ id: "kp_admin", email: "admin@example.test" }], organizations: [{ code: "org_acme", name: "Acme Inc." }] },
  });
});
afterAll(() => running.close());

describe("HTTPS mode", () => {
  it("serves https with a certificate written to disk", () => {
    expect(running.url).toMatch(/^https:\/\/localhost:\d+$/);
    expect(running.issuer).toBe(running.url);
    expect(running.certificatePath).toBe(join(certDirectory, "localhost-cert.pem"));
  });

  it("runs Kinde's official @kinde/management-api-js client unchanged", async () => {
    const scriptDirectory = join(process.cwd(), "node_modules", ".cache", "kinde-testkit");
    mkdirSync(scriptDirectory, { recursive: true });
    const script = join(scriptDirectory, "management-client.mjs");
    writeFileSync(
      script,
      `
      import { init, Users, Organizations } from "@kinde/management-api-js";
      init({ kindeDomain: process.env.ISSUER });
      const created = await Organizations.createOrganization({ body: { name: "Globex" } });
      const users = await Users.getUsers({});
      const org = await Organizations.getOrganization({ query: { code: created.organization.code } });
      console.log(JSON.stringify({ users: users.users.map((u) => u.email), org: org.name }));
      `,
    );
    const result = await promisify(execFile)(process.execPath, [script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: running.certificatePath!,
        ISSUER: running.issuer,
        KINDE_MANAGEMENT_CLIENT_ID: "management",
        KINDE_MANAGEMENT_CLIENT_SECRET: "secret",
      },
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.trim())).toEqual({ users: ["admin@example.test"], org: "Globex" });
  });

  it("reuses the same certificate on the next start", async () => {
    const again = await startKindeTestkit({ port: 0, https: { certDirectory } });
    try {
      expect(again.certificatePath).toBe(running.certificatePath);
    } finally {
      await again.close();
    }
  });
});
