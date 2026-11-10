import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scenario, type InvalidTokenKind } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const AUDIENCE = "https://projects-api.example.test";
const kinde = useKindeTestkit({ audience: AUDIENCE });

const projects = [
  { id: "p1", org: "org_acme", name: "Customer portal" },
  { id: "p2", org: "org_globex", name: "Billing migration" },
];

function startProjectsApi(issuer: string): Promise<{ url: string; server: Server }> {
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return send(401, { error: "unauthenticated" });

    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(header.slice(7), jwks, {
        issuer,
        audience: AUDIENCE,
        algorithms: ["RS256"],
      }));
    } catch {
      return send(401, { error: "invalid_token" });
    }

    const org = claims.org_code;
    if (typeof claims.sub !== "string" || typeof org !== "string") return send(403, { error: "no_org" });
    const permissions = Array.isArray(claims.permissions) ? claims.permissions : [];
    const [, , id] = (req.url ?? "").split("/");
    const project = projects.find((p) => p.id === id);

    if (req.method === "GET" && !id) {
      if (!permissions.includes("projects:read")) return send(403, { error: "forbidden" });
      return send(200, projects.filter((p) => p.org === org));
    }
    if (req.method === "DELETE" && project) {
      if (!permissions.includes("projects:delete")) return send(403, { error: "forbidden" });
      if (project.org !== org) return send(404, { error: "not_found" });
      return send(204, null);
    }
    return send(404, { error: "not_found" });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    ),
  );
}

const scenarios = {
  admin: scenario()
    .user({ email: "admin@example.test" })
    .organization("org_acme")
    .role("admin")
    .permissions(["projects:read", "projects:delete"])
    .authenticated(),
  viewer: scenario()
    .user({ email: "viewer@example.test" })
    .organization("org_acme")
    .role("viewer")
    .permissions(["projects:read"])
    .authenticated(),
  anonymous: scenario().unauthenticated(),
};

let api: { url: string; server: Server };
beforeAll(async () => {
  api = await startProjectsApi(kinde.issuer);
});
afterAll(() => new Promise<void>((resolve) => api.server.close(() => resolve())));

async function call(method: string, path: string, headers: Record<string, string>) {
  return fetch(`${api.url}${path}`, { method, headers });
}

describe("a projects API checked with its own JWT middleware", () => {
  it("lets an admin list only their organization's projects", async () => {
    const { headers } = await kinde.auth(scenarios.admin);
    const response = await call("GET", "/projects", headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "p1", org: "org_acme", name: "Customer portal" }]);
  });

  it("lets an admin delete a project in their organization", async () => {
    const { headers } = await kinde.auth(scenarios.admin);
    expect((await call("DELETE", "/projects/p1", headers)).status).toBe(204);
  });

  it("stops a viewer from deleting", async () => {
    const { headers } = await kinde.auth(scenarios.viewer);
    expect((await call("DELETE", "/projects/p1", headers)).status).toBe(403);
  });

  it("hides another organization's project", async () => {
    const { headers } = await kinde.auth(scenarios.admin);
    expect((await call("DELETE", "/projects/p2", headers)).status).toBe(404);
  });

  it("rejects anonymous requests", async () => {
    const { headers } = await kinde.auth(scenarios.anonymous);
    expect((await call("GET", "/projects", headers)).status).toBe(401);
  });

  it.each<[InvalidTokenKind, number]>([
    ["expired", 401],
    ["wrong-issuer", 401],
    ["wrong-audience", 401],
    ["bad-signature", 401],
    ["unknown-key", 401],
    ["unsigned", 401],
    ["missing-organization", 403],
    ["missing-permissions", 403],
  ])("answers a %s token with %i", async (invalid, status) => {
    const { headers } = await kinde.auth(scenarios.admin, { invalid });
    expect((await call("GET", "/projects", headers)).status).toBe(status);
  });
});
