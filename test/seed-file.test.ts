import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { findSeedFile, loadSeedFile, startKindeTestkit, TestkitError } from "../src/index.js";

const folder = mkdtempSync(join(tmpdir(), "kinde-seed-"));
const file = (name: string, content: string) => {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
};

const yaml = `
issuer: http://localhost:4400
users:
  - id: kp_admin
    email: admin@example.com
    givenName: John
organizations:
  - code: org_acme
    name: Acme Inc.
memberships:
  - user: kp_admin
    organization: org_acme
    roles: [admin]
    permissions:
      - projects:read
      - projects:delete
`;

describe("seed files", () => {
  it("reads YAML", async () => {
    expect(await loadSeedFile(file("kinde-testkit.yaml", yaml))).toMatchObject({
      issuer: "http://localhost:4400",
      users: [{ id: "kp_admin", givenName: "John" }],
      memberships: [{ permissions: ["projects:read", "projects:delete"] }],
    });
  });

  it("reads a JavaScript module's default export and a TypeScript module's named export", async () => {
    const js = await loadSeedFile(file("seed.mjs", `export default { users: [{ id: "kp_js", email: "js@example.test" }] };`));
    expect(js.users).toEqual([{ id: "kp_js", email: "js@example.test" }]);
    const ts = await loadSeedFile(
      file("seed.ts", `const users: Array<{ id: string; email: string }> = [{ id: "kp_ts", email: "ts@example.test" }];\nexport const seed = { users };\n`),
    );
    expect(ts.users).toEqual([{ id: "kp_ts", email: "ts@example.test" }]);
  });

  it("explains a broken file", async () => {
    const broken = file("broken.yaml", "users: [\n  - id: kp");
    const error = await loadSeedFile(broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TestkitError);
    expect((error as TestkitError).message).toContain(`Could not read the seed file at ${broken}`);
    await expect(loadSeedFile(file("list.json", "[1, 2]"))).rejects.toThrow("must contain an object");
  });

  it("finds the default seed file", () => {
    const empty = mkdtempSync(join(tmpdir(), "kinde-seed-none-"));
    expect(findSeedFile(empty)).toBeUndefined();
    writeFileSync(join(empty, "kinde-testkit.yml"), "users: []");
    expect(findSeedFile(empty)).toBe(join(empty, "kinde-testkit.yml"));
  });

  it("starts from a seed file path and still validates references", async () => {
    const running = await startKindeTestkit({ port: 0, seed: file("start.yaml", yaml.replace("issuer: http://localhost:4400\n", "")) });
    try {
      const token = await running.testkit.tokenFor({
        kind: "authenticated",
        user: running.seed.users[0]!,
        organization: running.seed.organizations[0]!,
        roles: ["admin"],
        permissions: ["projects:read"],
        claims: {},
      });
      expect(decodeJwt(token!)).toMatchObject({ sub: "kp_admin", org_code: "org_acme" });
    } finally {
      await running.close();
    }
    const bad = file("bad.yaml", "memberships:\n  - user: kp_ghost\n    organization: org_none\n");
    await expect(startKindeTestkit({ port: 0, seed: bad })).rejects.toThrow("The seed has problems");
  });
});

describe("runtime seed and stop", () => {
  it("replaces the seed while running, and reset returns to the new seed", async () => {
    const running = await startKindeTestkit({ port: 0, seed: { users: [{ id: "kp_old", email: "old@example.test" }] } });
    try {
      const load = await fetch(`${running.url}/testkit/seed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ users: [{ id: "kp_new", email: "new@example.test" }], organizations: [{ code: "org_new" }], memberships: [{ user: "kp_new", organization: "org_new" }] }),
      });
      expect(await load.json()).toEqual({ ok: true, users: 1, organizations: 1, memberships: 1 });
      expect(((await (await fetch(`${running.url}/testkit/users`)).json()) as Array<{ id: string }>).map((u) => u.id)).toEqual(["kp_new"]);

      running.directory.createUser({ email: "temp@example.test" });
      running.reset();
      expect(running.seed.users.map((u) => u.id)).toEqual(["kp_new"]);

      const invalid = await fetch(`${running.url}/testkit/seed`, { method: "POST", body: JSON.stringify({ memberships: [{ user: "kp_ghost", organization: "org_x" }] }) });
      expect(invalid.status).toBe(400);
      expect(running.seed.users.map((u) => u.id)).toEqual(["kp_new"]);
    } finally {
      await running.close();
    }
  });

  it("stops when asked over HTTP", async () => {
    const running = await startKindeTestkit({ port: 0 });
    expect((await fetch(`${running.url}/testkit/stop`, { method: "POST" })).status).toBe(200);
    await expect.poll(() => fetch(`${running.url}/testkit/health`).then(() => "up", () => "down")).toBe("down");
    await running.close();
  });
});
