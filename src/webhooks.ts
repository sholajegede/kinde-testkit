import { randomBytes } from "node:crypto";
import { TestkitError } from "./errors.js";
import { slug, stableId, titleCase } from "./ids.js";
import { findUser, type ResolvedSeed } from "./seed.js";
import type { KindeTestkit } from "./testkit.js";
import type { KindeUser } from "./types.js";

export const WEBHOOK_EVENT_TYPES = [
  "user.created",
  "user.updated",
  "user.deleted",
  "user.authenticated",
  "user.authentication_failed",
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "role.created",
  "role.updated",
  "role.deleted",
  "permission.created",
  "permission.updated",
  "permission.deleted",
  "subscriber.created",
  "access_request.created",
] as const;

export const BILLING_EVENT_TYPES = [
  "customer.agreement_cancelled",
  "customer.agreement_created",
  "customer.invoice_overdue",
  "customer.meter_usage_updated",
  "customer.payment_failed",
  "customer.payment_succeeded",
  "customer.plan_assigned",
  "customer.plan_changed",
] as const;

export type WebhookInvalidKind = "bad-signature" | "unknown-key" | "unsigned" | "stale";
export type WebhookSource = "admin" | "api" | "user";

export interface WebhookEndpointInput {
  url: string;
  events?: string[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[] | null;
}

export interface SendWebhookOptions {
  type: string;
  data?: Record<string, unknown>;
  user?: string;
  organization?: string;
  role?: string;
  permission?: string;
  source?: WebhookSource;
  ipAddress?: string;
  to?: string;
  duplicate?: number;
  delayMs?: number;
  invalid?: WebhookInvalidKind;
}

export interface WebhookAttempt {
  attempt: number;
  status: number | null;
  error: string | null;
  durationMs: number;
}

export interface WebhookDelivery {
  webhookId: string;
  eventId: string;
  type: string;
  url: string;
  copy: number;
  delivered: boolean;
  attempts: WebhookAttempt[];
  payload: Record<string, unknown>;
}

export interface WebhookOptions {
  retryDelaysMs?: number[];
  timeoutMs?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [0, 100, 500];
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_DUPLICATES = 10;

export class WebhookDispatcher {
  private endpoints: WebhookEndpoint[] = [];
  private seededEndpoints: WebhookEndpoint[] = [];
  private log: WebhookDelivery[] = [];
  private nextEndpoint = 1;
  private readonly retryDelaysMs: number[];
  private readonly timeoutMs: number;

  constructor(
    private readonly testkit: KindeTestkit,
    private readonly seed: ResolvedSeed,
    endpoints: WebhookEndpointInput[] = [],
    options: WebhookOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const endpoint of endpoints) this.addEndpoint(endpoint);
    this.seededEndpoints = [...this.endpoints];
  }

  addEndpoint(input: WebhookEndpointInput): WebhookEndpoint {
    if (!isHttpUrl(input.url)) {
      throw new TestkitError("INVALID_REQUEST", `Webhook URL "${String(input.url)}" must be an http or https URL.`);
    }
    if (input.events !== undefined && (!Array.isArray(input.events) || input.events.some((e) => typeof e !== "string"))) {
      throw new TestkitError("INVALID_REQUEST", "Webhook events must be a list of event type names.");
    }
    const endpoint = { id: `endpoint_${this.nextEndpoint++}`, url: input.url, events: input.events ?? null };
    this.endpoints.push(endpoint);
    return { ...endpoint };
  }

  removeEndpoint(id: string): boolean {
    const before = this.endpoints.length;
    this.endpoints = this.endpoints.filter((e) => e.id !== id);
    return this.endpoints.length < before;
  }

  listEndpoints(): WebhookEndpoint[] {
    return this.endpoints.map((e) => ({ ...e }));
  }

  deliveries(): WebhookDelivery[] {
    return this.log.map((d) => ({ ...d, attempts: [...d.attempts] }));
  }

  reset(): void {
    this.log = [];
    this.endpoints = [...this.seededEndpoints];
  }

  buildEvent(options: SendWebhookOptions): Record<string, unknown> {
    if (typeof options.type !== "string" || !/^[a-z_]+\.[a-z_]+$/.test(options.type)) {
      throw new TestkitError("INVALID_REQUEST", `"${String(options.type)}" is not a webhook event type, such as user.created.`);
    }
    const now = new Date();
    const timestamp = (options.invalid === "stale" ? new Date(now.getTime() - 3_600_000) : now).toISOString();
    const event: Record<string, unknown> = {
      data: options.data ?? this.buildData(options),
      event_id: `event_${randomBytes(16).toString("hex")}`,
      event_timestamp: timestamp,
      source: options.source ?? "admin",
      timestamp,
      type: options.type,
    };
    if (options.type === "user.authenticated" || options.type === "user.authentication_failed") {
      event.ip_address = options.ipAddress ?? "127.0.0.1";
    }
    return event;
  }

  async send(options: SendWebhookOptions): Promise<WebhookDelivery[]> {
    const event = this.buildEvent(options);
    const copies = options.duplicate ?? 1;
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_DUPLICATES) {
      throw new TestkitError("INVALID_REQUEST", `"duplicate" must be a whole number from 1 to ${MAX_DUPLICATES}.`);
    }
    const targets = options.to
      ? [{ id: "direct", url: options.to, events: null }]
      : this.endpoints.filter((e) => e.events === null || e.events.includes(options.type));
    if (options.to && !isHttpUrl(options.to)) {
      throw new TestkitError("INVALID_REQUEST", `"to" must be an http or https URL.`);
    }
    if (targets.length === 0) {
      throw new TestkitError(
        "INVALID_REQUEST",
        `No webhook endpoint listens for ${options.type}. Add one in the seed's "webhooks", with addEndpoint(), or pass "to".`,
      );
    }
    if (options.delayMs) await sleep(Math.min(options.delayMs, 60_000));
    const signed = await this.testkit.signPayload(
      event,
      options.invalid === "stale" ? undefined : options.invalid,
    );
    const jobs = targets.flatMap((target) => {
      const webhookId = `wh_${randomBytes(12).toString("hex")}`;
      return Array.from({ length: copies }, (_, index) => this.deliver(target.url, webhookId, signed, event, index + 1));
    });
    return Promise.all(jobs);
  }

  private async deliver(
    url: string,
    webhookId: string,
    body: string,
    event: Record<string, unknown>,
    copy: number,
  ): Promise<WebhookDelivery> {
    const delivery: WebhookDelivery = {
      webhookId,
      eventId: String(event.event_id),
      type: String(event.type),
      url,
      copy,
      delivered: false,
      attempts: [],
      payload: event,
    };
    this.log.push(delivery);
    for (const [index, delay] of this.retryDelaysMs.entries()) {
      if (delay > 0) await sleep(delay);
      const started = Date.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/jwt", "webhook-id": webhookId },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        await response.arrayBuffer().catch(() => undefined);
        delivery.attempts.push({ attempt: index + 1, status: response.status, error: null, durationMs: Date.now() - started });
        if (response.status === 200) {
          delivery.delivered = true;
          break;
        }
      } catch (error) {
        const name = (error as Error).name;
        delivery.attempts.push({
          attempt: index + 1,
          status: null,
          error: name === "TimeoutError" ? `No answer within ${this.timeoutMs}ms` : (error as Error).message,
          durationMs: Date.now() - started,
        });
      }
    }
    return { ...delivery, attempts: [...delivery.attempts] };
  }

  private buildData(options: SendWebhookOptions): Record<string, unknown> {
    const [subject] = options.type.split(".");
    switch (subject) {
      case "user":
        return { user: this.userData(options) };
      case "organization":
        return { organization: this.organizationData(options) };
      case "role":
        return { role: this.namedData(options, "role") };
      case "permission":
        return { permission: this.namedData(options, "permission") };
      case "subscriber": {
        const user = this.requireUser(options);
        return {
          subscriber: {
            email: user.email,
            first_name: user.givenName,
            id: stableId("sub", user.id),
            last_name: user.familyName,
            user_id: user.id,
          },
        };
      }
      case "access_request": {
        const user = this.requireUser(options);
        return {
          access_request: { email: user.email, first_name: user.givenName, last_name: user.familyName, user_id: user.id },
        };
      }
      default:
        throw new TestkitError(
          "INVALID_REQUEST",
          `kinde-testkit has no built-in payload for ${options.type}. Pass "data" with the event's data object.`,
        );
    }
  }

  emitForUser(type: "user.created" | "user.authenticated", user: KindeUser): void {
    if (!this.endpoints.some((e) => e.events === null || e.events.includes(type))) return;
    const data = type === "user.created" ? { user: this.userPayload(user) } : { user: { id: user.id } };
    void this.send({ type, data, source: "user" }).catch(() => undefined);
  }

  private userData(options: SendWebhookOptions): Record<string, unknown> {
    const user = this.requireUser(options);
    if (options.type !== "user.created" && options.type !== "user.updated") return { id: user.id };
    return this.userPayload(user);
  }

  private userPayload(user: KindeUser): Record<string, unknown> {
    return {
      email: user.email,
      first_name: user.givenName,
      id: user.id,
      is_password_reset_requested: false,
      is_suspended: false,
      last_name: user.familyName,
      organizations: this.seed.memberships
        .filter((m) => m.userId === user.id)
        .map((m) => ({
          code: m.organizationCode,
          permissions: m.permissions.length > 0 ? m.permissions.map((key) => ({ id: stableId("perm", key), key })) : null,
          roles: m.roles.length > 0 ? m.roles.map((key) => ({ id: stableId("role", key), key })) : null,
        })),
      phone: null,
      username: typeof user.claims.username === "string" ? user.claims.username : null,
    };
  }

  private organizationData(options: SendWebhookOptions): Record<string, unknown> {
    if (!options.organization) {
      throw new TestkitError("INVALID_REQUEST", `${options.type} needs "organization", the organization code.`);
    }
    const org = this.seed.organizations.find((o) => o.code === options.organization);
    if (options.type === "organization.deleted") return { code: options.organization };
    const name = org?.name ?? titleCase(options.organization);
    const data: Record<string, unknown> = { code: options.organization, external_id: null, handle: slug(name), name };
    if (options.type === "organization.updated") data.is_allow_registrations = false;
    return data;
  }

  private namedData(options: SendWebhookOptions, kind: "role" | "permission"): Record<string, unknown> {
    const key = kind === "role" ? options.role : options.permission;
    if (!key) throw new TestkitError("INVALID_REQUEST", `${options.type} needs "${kind}", the ${kind} key.`);
    const id = stableId(kind === "role" ? "role" : "perm", key);
    if (options.type.endsWith(".deleted")) return { id };
    const data: Record<string, unknown> = { description: "", id, key, name: titleCase(key) };
    if (kind === "role") data.is_default_role = false;
    return data;
  }

  private requireUser(options: SendWebhookOptions): KindeUser {
    if (!options.user) throw new TestkitError("INVALID_REQUEST", `${options.type} needs "user", a seeded user's id or email.`);
    const user = findUser(this.seed.users, options.user);
    if (!user) throw new TestkitError("SEED_UNKNOWN_USER", `No seeded user matches "${options.user}".`);
    return user;
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
