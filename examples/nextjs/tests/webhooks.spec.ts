import { expect, test } from "kinde-testkit/playwright";

const ENDPOINT = "http://localhost:3000/api/webhooks/kinde";

test("the app verifies and records a Kinde webhook", async ({ kinde, request }) => {
  const [delivery] = await kinde.sendWebhook({ type: "user.created", user: "admin@example.test", to: ENDPOINT });
  expect(delivery!.delivered).toBe(true);

  const record = await (await request.get(`${ENDPOINT}?id=${delivery!.webhookId}`)).json();
  expect(record).toEqual({ type: "user.created", eventId: delivery!.eventId, count: 1 });
});

test("a retried or duplicated webhook is processed once", async ({ kinde, request }) => {
  const deliveries = await kinde.sendWebhook({ type: "organization.created", organization: "org_acme", to: ENDPOINT, duplicate: 3 });
  expect(deliveries.every((d) => d.delivered)).toBe(true);

  const record = await (await request.get(`${ENDPOINT}?id=${deliveries[0]!.webhookId}`)).json();
  expect(record.count).toBe(3);
});

const forged = {
  "bad-signature": "with a tampered signature",
  "unknown-key": "signed by an unknown key",
  unsigned: "with no signature",
  stale: "an hour old",
} as const;

for (const [invalid, description] of Object.entries(forged) as [keyof typeof forged, string][]) {
  test(`the app rejects a webhook ${description}`, async ({ kinde, request }) => {
    const [delivery] = await kinde.sendWebhook({ type: "user.deleted", user: "admin@example.test", to: ENDPOINT, invalid });
    expect(delivery!.delivered).toBe(false);
    expect(delivery!.attempts.every((a) => a.status === 400)).toBe(true);
    expect((await request.get(`${ENDPOINT}?id=${delivery!.webhookId}`)).status()).toBe(404);
  });
}
