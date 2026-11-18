import { beforeEach, describe, expect, it } from "vitest";
import { useKindeTestkit } from "../src/vitest.js";

const kinde = useKindeTestkit({
  seed: {
    users: [{ id: "kp_admin", email: "admin@example.test", givenName: "Ada" }],
    organizations: [{ code: "org_acme", name: "Acme Inc." }],
    roles: [{ key: "admin", permissions: ["projects:delete"] }],
    memberships: [{ user: "kp_admin", organization: "org_acme", roles: ["admin"] }],
  },
});
beforeEach(() => {
  kinde.reset();
  kinde.activity.reset();
});

async function page(path = "/dashboard") {
  const response = await fetch(`${kinde.url}${path}`);
  return { status: response.status, html: await response.text() };
}

async function post(path: string, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return fetch(`${kinde.url}${path}`, {
    method: "POST",
    body: new URLSearchParams(form),
    headers: { origin: kinde.url, ...headers },
    redirect: "manual",
  });
}

describe("dashboard", () => {
  it("shows users, organizations and memberships with the permissions their tokens get", async () => {
    const { status, html } = await page();
    expect(status).toBe(200);
    expect(html).toContain("admin@example.test");
    expect(html).toContain("Acme Inc.");
    expect(html).toContain('<span class="chip">projects:delete</span>');
    expect(html).toContain("Coverage: 0/47");
  });

  it("lists issued tokens with their claims", async () => {
    await fetch(`${kinde.url}/testkit/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "kp_admin", invalid: "expired" }) });
    const { html } = await page();
    expect(html).toContain("<code>kp_admin</code>");
    expect(html).toContain('<span class="bad">expired</span>');
    expect(kinde.activity.tokens()[0]).toMatchObject({ kind: "access", subject: "kp_admin", organization: "org_acme", invalid: "expired" });
  });

  it("logs requests to Kinde endpoints and hides codes and secrets", async () => {
    await fetch(`${kinde.url}/oauth2/auth?client_id=app&response_type=code&code=abc&redirect_uri=${encodeURIComponent("http://localhost:3000/cb")}`);
    await fetch(`${kinde.url}/testkit/users`);
    const requests = (await (await fetch(`${kinde.url}/testkit/requests`)).json()) as Array<{ path: string; status: number }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toContain("code=%E2%80%A6");
    expect(requests[0]!.path).not.toContain("abc");
    expect(requests[0]!.status).toBe(200);
  });

  it("adds and removes failure rules from the page", async () => {
    const added = await post("/dashboard/failures", { path: "/oauth2/token", status: "503", times: "1" });
    expect(added.status).toBe(303);
    expect(decodeURIComponent(added.headers.get("location")!)).toContain("Added failure_");
    const [rule] = kinde.failures.list();
    expect(rule).toMatchObject({ path: "/oauth2/token", status: 503, remaining: 1 });
    expect((await page()).html).toContain("Status 503");
    await post(`/dashboard/failures/${rule!.id}/remove`);
    expect(kinde.failures.list()).toEqual([]);
  });

  it("shows a readable message for a bad failure rule", async () => {
    const response = await post("/dashboard/failures", { path: "oauth2/token", status: "503" });
    expect(decodeURIComponent(response.headers.get("location")!)).toContain("The failure rule is not valid.");
  });

  it("resets state from the page", async () => {
    kinde.failures.add({ path: "/logout", status: 500 });
    await post("/dashboard/reset");
    expect(kinde.failures.list()).toEqual([]);
  });

  it("refuses actions posted from another site", async () => {
    kinde.failures.add({ path: "/logout", status: 500 });
    const response = await post("/dashboard/reset", {}, { origin: "https://attacker.example" });
    expect(response.status).toBe(403);
    expect(kinde.failures.list()).toHaveLength(1);
  });

  it("turns on live updates", async () => {
    expect((await page("/dashboard?live=1")).html).toContain('http-equiv="refresh"');
  });
});
