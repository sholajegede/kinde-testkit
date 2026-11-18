import { execFileSync } from "node:child_process";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { scenario, startKindeTestkit } from "../dist/index.js";

const running = await startKindeTestkit({ port: 0, audience: "https://api.example.test" });
try {
  const admin = scenario().user({ email: "admin@example.test" }).organization("org_acme").authenticated();
  const token = await running.testkit.tokenFor(admin);
  const jwks = createRemoteJWKSet(new URL(`${running.url}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { issuer: running.issuer, audience: "https://api.example.test" });
  if (payload.org_code !== "org_acme") throw new Error(`unexpected org_code ${payload.org_code}`);

  const minted = await fetch(`${running.url}/testkit/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "kp_smoke" }),
  });
  if (!minted.ok) throw new Error(`POST /testkit/token returned ${minted.status}`);

  const help = execFileSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "help"], { encoding: "utf8" });
  if (!help.includes("kinde-testkit start")) throw new Error("CLI help is missing the start command");

  console.log(`kinde-testkit runs on Node ${process.versions.node}`);
} finally {
  await running.close();
}
