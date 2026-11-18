import type { IncomingMessage, ServerResponse } from "node:http";
import type { JWTPayload } from "jose";
import type { Directory } from "./directory.js";
import { effectivePermissions } from "./seed.js";
import type { KindeTestkit } from "./testkit.js";

const DEFAULT_PAGE_SIZE = 10;

export class AccountApi {
  constructor(
    private readonly testkit: KindeTestkit,
    private readonly directory: Directory,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/account_api/v1/")) return false;
    if ((req.method ?? "GET") !== "GET") {
      sendJson(res, 405, errors("METHOD_NOT_ALLOWED", "The Account API endpoints kinde-testkit implements are GET only."));
      return true;
    }
    const header = req.headers.authorization ?? "";
    let token: JWTPayload;
    try {
      if (!header.startsWith("Bearer ")) throw new Error("missing");
      token = await this.testkit.verify(header.slice(7));
    } catch {
      sendJson(res, 403, errors("TOKEN_INVALID", "Send the user's access token from this issuer as a Bearer token."));
      return true;
    }
    if (typeof token.sub !== "string" || (Array.isArray(token.gty) && token.gty.includes("client_credentials"))) {
      sendJson(res, 403, errors("USER_TOKEN_REQUIRED", "The Account API needs a user access token, not a machine-to-machine token."));
      return true;
    }

    const userId = token.sub;
    const orgCode = typeof token.org_code === "string" ? token.org_code : null;
    const path = url.pathname.slice("/account_api/v1/".length);
    const d = this.directory;
    const membership = orgCode ? d.membership(userId, orgCode) : undefined;

    if (path === "permissions") {
      const items = effectivePermissions(d.seed, membership).map((key) => {
        const p = d.ensurePermission(key);
        return { id: p.id, name: p.name, key: p.key };
      });
      sendPage(res, url, "permissions", items, { org_code: orgCode });
      return true;
    }
    if (path.startsWith("permission/")) {
      const key = decodeURIComponent(path.slice("permission/".length));
      sendJson(res, 200, {
        data: { org_code: orgCode, permission_key: key, is_granted: effectivePermissions(d.seed, membership).includes(key) },
      });
      return true;
    }
    if (path === "roles") {
      const items = (membership?.roles ?? []).map((key) => {
        const r = d.ensureRole(key);
        return { id: r.id, name: r.name, key: r.key };
      });
      sendPage(res, url, "roles", items, { org_code: orgCode });
      return true;
    }
    if (path === "feature_flags") {
      const items = d.seed.featureFlags.map((flag) => ({
        id: flag.id,
        name: flag.name,
        key: flag.key,
        type: flag.type,
        value: orgCode && orgCode in flag.organizations ? flag.organizations[orgCode] : flag.value,
      }));
      sendPage(res, url, "feature_flags", items, {});
      return true;
    }
    if (path === "properties") {
      const values = d.seed.userProperties[userId] ?? {};
      const items = Object.entries(values).map(([key, value]) => ({ id: `prop_${key}`, name: key, key, value }));
      sendPage(res, url, "properties", items, {});
      return true;
    }
    if (path === "entitlements" || path.startsWith("entitlement")) {
      const plan =
        d.seed.plans.find((p) => p.subscribers.includes(userId)) ??
        (orgCode ? d.seed.plans.find((p) => p.subscribers.includes(orgCode)) : undefined);
      const entitlements = (plan?.entitlements ?? []).map((e) => ({
        id: e.id,
        fixed_charge: e.fixedCharge,
        price_name: e.priceName,
        unit_amount: e.unitAmount,
        feature_key: e.featureKey,
        feature_name: e.featureName,
        entitlement_limit_max: e.limitMax,
        entitlement_limit_min: e.limitMin,
      }));
      if (path === "entitlements") {
        const plans = plan ? [{ key: plan.key, name: plan.name, subscribed_on: plan.subscribedOn }] : [];
        sendPage(res, url, "entitlements", entitlements, { org_code: orgCode, plans });
        return true;
      }
      const key = decodeURIComponent(path.replace(/^entitlement\/?/, "")) || url.searchParams.get("key") || "";
      const entitlement = entitlements.find((e) => e.feature_key === key);
      if (!entitlement) {
        sendJson(res, 404, errors("ENTITLEMENT_NOT_FOUND", `No entitlement for the feature ${key}.`));
      } else {
        sendJson(res, 200, { data: { org_code: orgCode, entitlement }, metadata: {} });
      }
      return true;
    }
    if (path === "portal_link") {
      sendJson(res, 200, { url: `${this.testkit.issuer}/testkit/portal?subnav=${encodeURIComponent(url.searchParams.get("subnav") ?? "profile")}` });
      return true;
    }
    sendJson(res, 404, errors("ROUTE_NOT_FOUND", `kinde-testkit does not implement GET ${url.pathname}.`));
    return true;
  }
}

function sendPage<T extends { id: string }>(
  res: ServerResponse,
  url: URL,
  field: string,
  items: T[],
  extra: Record<string, unknown>,
): void {
  const size = Math.max(Number(url.searchParams.get("page_size") ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1);
  const after = url.searchParams.get("starting_after");
  const start = after ? items.findIndex((item) => item.id === after) + 1 : 0;
  const page = items.slice(start, start + size);
  const hasMore = start + size < items.length;
  sendJson(res, 200, {
    data: { ...extra, [field]: page },
    metadata: { has_more: hasMore, next_page_starting_after: page.at(-1)?.id ?? null },
  });
}

function errors(code: string, message: string) {
  return { errors: [{ code, message }] };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
