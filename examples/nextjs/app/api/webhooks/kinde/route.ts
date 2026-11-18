import { decodeWebhook } from "@kinde/webhooks";

const processed = new Map<string, { type: string; eventId: string; count: number }>();

export async function POST(request: Request) {
  const webhookId = request.headers.get("webhook-id") ?? "";
  const event = await decodeWebhook<{ type: string; event_id: string; timestamp: string }>(
    await request.text(),
    process.env.KINDE_ISSUER_URL,
  );
  if (!event) return new Response("Invalid webhook", { status: 400 });
  if (Date.now() - Date.parse(event.timestamp) > 5 * 60 * 1000) {
    return new Response("Stale webhook", { status: 400 });
  }

  const seen = processed.get(webhookId);
  if (seen) {
    seen.count += 1;
    return new Response("Already processed", { status: 200 });
  }
  processed.set(webhookId, { type: event.type, eventId: event.event_id, count: 1 });
  return new Response("OK", { status: 200 });
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const record = processed.get(id);
  return Response.json(record ?? null, { status: record ? 200 : 404 });
}
