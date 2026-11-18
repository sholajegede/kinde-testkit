import { describe, expect, it } from "vitest";
import { inspectToken, parseEnvFile, runDoctor, scenario } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

const kinde = useKindeTestkit({ seed: { users: [{ id: "kp_admin", email: "admin@example.test" }] } });
const admin = scenario().user({ email: "admin@example.test" }).organization("org_acme").authenticated();
const status = (checks: { name: string; status: string }[], name: string) => checks.find((c) => c.name === name)?.status;

describe("inspectToken", () => {
  it("passes a valid access token checked against the issuer", async () => {
    const result = await inspectToken((await kinde.testkit.tokenFor(admin))!, { issuerUrl: kinde.issuer });
    expect(result.kind).toBe("access");
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("recognises ID and M2M tokens", async () => {
    expect((await inspectToken((await kinde.testkit.idTokenFor(admin))!)).kind).toBe("id");
    expect((await inspectToken(await kinde.testkit.m2mToken({ clientId: "svc" }))).kind).toBe("m2m");
  });

  it("explains what is wrong with broken tokens", async () => {
    const expired = await inspectToken((await kinde.testkit.tokenFor(admin, { invalid: "expired" }))!, { issuerUrl: kinde.issuer });
    expect(status(expired.checks, "Expiry")).toBe("fail");
    expect(status(expired.checks, "Signature")).toBe("pass");

    const tampered = await inspectToken((await kinde.testkit.tokenFor(admin, { invalid: "bad-signature" }))!, { issuerUrl: kinde.issuer });
    expect(tampered.checks.find((c) => c.name === "Signature")).toMatchObject({ status: "fail", detail: expect.stringContaining("changed after signing") });

    const stranger = await inspectToken((await kinde.testkit.tokenFor(admin, { invalid: "unknown-key" }))!, { issuerUrl: kinde.issuer });
    expect(stranger.checks.find((c) => c.name === "Signature")?.detail).toContain("matches this token's kid");

    const unsigned = await inspectToken((await kinde.testkit.tokenFor(admin, { invalid: "unsigned" }))!);
    expect(status(unsigned.checks, "Algorithm")).toBe("fail");

    const wrongIssuer = await inspectToken((await kinde.testkit.tokenFor(admin, { invalid: "wrong-issuer" }))!, { issuerUrl: kinde.issuer });
    expect(status(wrongIssuer.checks, "Issuer")).toBe("fail");

    expect(status((await inspectToken("not-a-jwt")).checks, "Format")).toBe("fail");
  });
});

describe("runDoctor", () => {
  const good = {
    KINDE_CLIENT_ID: "kinde_testkit_example",
    KINDE_CLIENT_SECRET: "testkitexampleclientsecret0000000000000000",
    KINDE_SITE_URL: "http://localhost:3000",
  };

  it("passes a correctly configured app", async () => {
    const report = await runDoctor({ url: kinde.url, env: { ...good, KINDE_ISSUER_URL: kinde.issuer } });
    expect(report.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("catches the usual mistakes", async () => {
    const report = await runDoctor({
      url: kinde.url,
      env: { KINDE_ISSUER_URL: "https://acme.kinde.com", KINDE_CLIENT_SECRET: "short", KINDE_SITE_URL: "localhost:3000" },
    });
    expect(report.ok).toBe(false);
    expect(status(report.checks, "KINDE_ISSUER_URL")).toBe("fail");
    expect(status(report.checks, "KINDE_CLIENT_ID")).toBe("fail");
    expect(status(report.checks, "KINDE_CLIENT_SECRET")).toBe("fail");
    expect(status(report.checks, "KINDE_SITE_URL")).toBe("fail");
  });

  it("flags an issuer URL that differs from the running one", async () => {
    const report = await runDoctor({ url: kinde.url, env: { ...good, KINDE_ISSUER_URL: "http://localhost:9999" } });
    expect(report.checks.find((c) => c.name === "KINDE_ISSUER_URL")?.detail).toContain("does not match");
  });

  it("reports an issuer that is not running", async () => {
    const report = await runDoctor({ url: "http://127.0.0.1:1", env: good });
    expect(status(report.checks, "Issuer running")).toBe("fail");
  });
});

describe("parseEnvFile", () => {
  it("reads quoted, exported and commented values", () => {
    expect(
      parseEnvFile(['KINDE_ISSUER_URL="http://localhost:4400"', "export KINDE_CLIENT_ID=abc # comment", "# KINDE_SITE_URL=x", "KINDE_SCOPE='openid email'"].join("\n")),
    ).toEqual({ KINDE_ISSUER_URL: "http://localhost:4400", KINDE_CLIENT_ID: "abc", KINDE_SCOPE: "openid email" });
  });
});
