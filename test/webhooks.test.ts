import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeWebhook } from "@kinde/webhooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BILLING_EVENT_TYPES, WEBHOOK_EVENT_TYPES, type TestkitSeed } from "../src/index.js";
import { useKindeTestkit } from "../src/vitest.js";

interface Received {
  contentType: string | undefined;
  webhookId: string | undefined;
  body: string;
}

const received: Received[] = [];
let respond: (index: number) => number | "hang" = () => 200;
let receiver: Server;
let receiverUrl = "";

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        contentType: req.headers["content-type"],
        webhookId: req.headers["webhook-id"] as string | undefined,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const answer = respond(received.length - 1);
      if (answer === "hang") return;
      res.writeHead(answer);
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhooks/kinde`;
});

afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise((resolve) => receiver.close(resolve));
});

const seed: TestkitSeed = {
  users: [{ id: "kp_admin", email: "admin@example.test", givenName: "Ada", familyName: "Okafor" }],
  organizations: [{ code: "org_acme", name: "Acme Inc." }],
  memberships: [{ user: "kp_admin", organization: "org_acme", roles: ["admin"], permissions: ["projects:delete"] }],
};

const kinde = useKindeTestkit({ seed, webhooks: { retryDelaysMs: [0, 20, 40], timeoutMs: 200 } });

beforeEach(() => {
  received.length = 0;
  respond = () => 200;
  kinde.reset();
  kinde.webhooks.addEndpoint({ url: receiverUrl });
});

describe("delivery format", () => {
  it("posts a signed JWT that Kinde's @kinde/webhooks decodes", async () => {
    const [delivery] = await kinde.webhooks.send({ type: "user.created", user: "admin@example.test" });
    expect(delivery).toMatchObject({ delivered: true, type: "user.created", attempts: [{ attempt: 1, status: 200 }] });

    const [request] = received;
    expect(request!.contentType).toBe("application/jwt");
    expect(request!.webhookId).toBe(delivery!.webhookId);

    const event = await decodeWebhook<Record<string, any>>(request!.body, kinde.issuer);
    expect(event).toMatchObject({
      type: "user.created",
      source: "admin",
      event_id: expect.stringMatching(/^event_/),
      data: {
        user: {
          id: "kp_admin",
          email: "admin@example.test",
          first_name: "Ada",
          last_name: "Okafor",
          is_suspended: false,
          is_password_reset_requested: false,
          phone: null,
          organizations: [
            {
              code: "org_acme",
              roles: [{ id: expect.stringMatching(/^role_/), key: "admin" }],
              permissions: [{ id: expect.stringMatching(/^perm_/), key: "projects:delete" }],
            },
          ],
        },
      },
    });
    expect(event!.timestamp).toBe(event!.event_timestamp);
    expect(Number.isNaN(Date.parse(event!.timestamp))).toBe(false);
  });

  it("builds every event type that @kinde/webhooks defines", async () => {
    const needs: Record<string, object> = {
      user: { user: "kp_admin" },
      organization: { organization: "org_acme" },
      role: { role: "admin" },
      permission: { permission: "projects:delete" },
      subscriber: { user: "kp_admin" },
      access_request: { user: "kp_admin" },
    };
    for (const type of WEBHOOK_EVENT_TYPES) {
      const [delivery] = await kinde.webhooks.send({ type, ...needs[type.split(".")[0]!] });
      expect(delivery!.delivered).toBe(true);
    }
    const events = await Promise.all(received.map((r) => decodeWebhook<Record<string, any>>(r.body, kinde.issuer)));
    expect(events.map((e) => e!.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
    const byType = Object.fromEntries(events.map((e) => [e!.type, e!]));
    expect(byType["user.authenticated"]).toMatchObject({ data: { user: { id: "kp_admin" } }, ip_address: "127.0.0.1" });
    expect(byType["organization.updated"]!.data.organization).toEqual({
      code: "org_acme",
      external_id: null,
      handle: "acme_inc",
      name: "Acme Inc.",
      is_allow_registrations: false,
    });
    expect(byType["role.deleted"]!.data).toEqual({ role: { id: expect.stringMatching(/^role_/) } });
    expect(byType["subscriber.created"]!.data.subscriber).toMatchObject({ email: "admin@example.test", user_id: "kp_admin" });
  });

  it("sends billing events with the data you pass", async () => {
    await expect(kinde.webhooks.send({ type: "customer.payment_succeeded" })).rejects.toThrow(/Pass "data"/);
    const data = { customer_id: "customer_123", plan: { code: "pro" } };
    await kinde.webhooks.send({ type: "customer.payment_succeeded", data });
    expect((await decodeWebhook<Record<string, any>>(received[0]!.body, kinde.issuer))!.data).toEqual(data);
    expect(BILLING_EVENT_TYPES).toContain("customer.payment_succeeded");
  });
});

describe("retries, timeouts and duplicates", () => {
  it("retries with the same webhook-id until it gets a 200", async () => {
    respond = (i) => (i < 2 ? 500 : 200);
    const [delivery] = await kinde.webhooks.send({ type: "user.deleted", user: "kp_admin" });
    expect(delivery!.attempts.map((a) => a.status)).toEqual([500, 500, 200]);
    expect(delivery!.delivered).toBe(true);
    expect(new Set(received.map((r) => r.webhookId)).size).toBe(1);
  });

  it("treats anything but 200 as a failure, as Kinde does", async () => {
    respond = () => 204;
    const [delivery] = await kinde.webhooks.send({ type: "user.deleted", user: "kp_admin" });
    expect(delivery!.delivered).toBe(false);
    expect(delivery!.attempts).toHaveLength(3);
  });

  it("records a timeout when the endpoint never answers", async () => {
    respond = (i) => (i === 0 ? "hang" : 200);
    const [delivery] = await kinde.webhooks.send({ type: "user.deleted", user: "kp_admin" });
    expect(delivery!.attempts[0]).toMatchObject({ status: null, error: "No answer within 200ms" });
    expect(delivery!.delivered).toBe(true);
  });

  it("sends duplicates with the same webhook-id and event_id", async () => {
    const deliveries = await kinde.webhooks.send({ type: "user.updated", user: "kp_admin", duplicate: 3 });
    expect(deliveries).toHaveLength(3);
    expect(new Set(received.map((r) => r.webhookId)).size).toBe(1);
    const events = await Promise.all(received.map((r) => decodeWebhook<Record<string, any>>(r.body, kinde.issuer)));
    expect(new Set(events.map((e) => e!.event_id)).size).toBe(1);
  });
});

describe("forged and stale webhooks", () => {
  it.each(["bad-signature", "unknown-key", "unsigned"] as const)("a %s webhook does not decode", async (invalid) => {
    await kinde.webhooks.send({ type: "user.deleted", user: "kp_admin", invalid });
    expect(await decodeWebhook(received[0]!.body, kinde.issuer)).toBeNull();
  });

  it("a stale webhook decodes but carries an hour-old timestamp", async () => {
    await kinde.webhooks.send({ type: "user.deleted", user: "kp_admin", invalid: "stale" });
    const event = await decodeWebhook<Record<string, any>>(received[0]!.body, kinde.issuer);
    expect(Date.now() - Date.parse(event!.timestamp)).toBeGreaterThan(3_500_000);
  });
});

describe("routing and control", () => {
  it("only sends an endpoint the events it subscribed to, unless told where to send", async () => {
    kinde.reset();
    kinde.webhooks.addEndpoint({ url: receiverUrl, events: ["user.created"] });
    await expect(kinde.webhooks.send({ type: "organization.created", organization: "org_acme" })).rejects.toThrow(/No webhook endpoint/);
    await kinde.webhooks.send({ type: "organization.created", organization: "org_acme", to: receiverUrl });
    expect(received).toHaveLength(1);
  });

  it("sends user.created and user.authenticated when a new email signs in", async () => {
    const authorize = await fetch(
      `${kinde.url}/oauth2/auth?client_id=app&redirect_uri=${encodeURIComponent("http://localhost:3000/cb")}&response_type=code`,
    );
    const request = /name="request" value="([^"]+)"/.exec(await authorize.text())![1]!;
    await fetch(`${kinde.url}/oauth2/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, email: "new.person@example.test" }),
      redirect: "manual",
    });
    await expect.poll(() => received.length).toBe(2);
    const events = await Promise.all(received.map((r) => decodeWebhook<Record<string, any>>(r.body, kinde.issuer)));
    expect(events.map((e) => e!.type).sort()).toEqual(["user.authenticated", "user.created"]);
    expect(events.every((e) => e!.source === "user")).toBe(true);
  });

  it("is controlled over HTTP", async () => {
    const sent = await fetch(`${kinde.url}/testkit/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "user.deleted", user: "kp_admin" }),
    });
    expect(((await sent.json()) as unknown[]).length).toBe(1);
    const log = (await (await fetch(`${kinde.url}/testkit/webhooks/deliveries`)).json()) as unknown[];
    expect(log).toHaveLength(1);
    const types = (await (await fetch(`${kinde.url}/testkit/webhooks/types`)).json()) as { built_in: string[] };
    expect(types.built_in).toContain("access_request.created");
  });

  it("reset clears deliveries and endpoints added at runtime", () => {
    kinde.reset();
    expect(kinde.webhooks.deliveries()).toEqual([]);
    expect(kinde.webhooks.listEndpoints()).toEqual([]);
  });
});
