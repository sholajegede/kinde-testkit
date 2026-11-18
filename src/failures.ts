import { TestkitError } from "./errors.js";

export interface FailureRule {
  path: string;
  method?: string;
  status?: number;
  delayMs?: number;
  hang?: boolean;
  times?: number;
  retryAfter?: number;
  /** Answer with a body your client cannot use. The status is 200 unless you set one. */
  malformed?: MalformedKind;
}

export type MalformedKind = "invalid-json" | "empty" | "html" | "unexpected-json";
export const MALFORMED_KINDS: readonly MalformedKind[] = ["invalid-json", "empty", "html", "unexpected-json"];

export interface ActiveFailure {
  id: string;
  path: string;
  method: string | null;
  status: number | null;
  delayMs: number;
  hang: boolean;
  remaining: number | null;
  retryAfter: number;
  malformed: MalformedKind | null;
  hits: number;
}

const MAX_DELAY_MS = 60_000;

export class FailureInjector {
  private rules: ActiveFailure[] = [];
  private nextId = 1;

  add(rule: FailureRule): ActiveFailure {
    const problems = validate(rule);
    if (problems.length > 0) {
      throw new TestkitError("INVALID_REQUEST", "The failure rule is not valid.", problems);
    }
    const active: ActiveFailure = {
      id: `failure_${this.nextId++}`,
      path: rule.path,
      method: rule.method ? rule.method.toUpperCase() : null,
      status: rule.status ?? null,
      delayMs: rule.delayMs ?? 0,
      hang: rule.hang ?? false,
      remaining: rule.times ?? null,
      retryAfter: rule.retryAfter ?? 1,
      malformed: rule.malformed ?? null,
      hits: 0,
    };
    this.rules.push(active);
    return { ...active };
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    return this.rules.length < before;
  }

  clear(): void {
    this.rules = [];
  }

  list(): ActiveFailure[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  take(method: string, path: string): ActiveFailure | null {
    const rule = this.rules.find((r) => matches(r, method, path));
    if (!rule) return null;
    rule.hits += 1;
    if (rule.remaining !== null) {
      rule.remaining -= 1;
      if (rule.remaining <= 0) this.remove(rule.id);
    }
    return { ...rule };
  }
}

export function failureBody(status: number): { error: string; error_description: string } {
  const error =
    status === 429 ? "rate_limited" : status === 503 ? "temporarily_unavailable" : status >= 500 ? "server_error" : "injected_failure";
  return { error, error_description: `kinde-testkit injected a ${status} response.` };
}

/** The body and content type for a malformed response. */
export function malformedBody(kind: MalformedKind): { contentType: string; body: string } {
  switch (kind) {
    case "invalid-json":
      return { contentType: "application/json", body: '{"access_token":' };
    case "empty":
      return { contentType: "application/json", body: "" };
    case "html":
      return { contentType: "text/html; charset=utf-8", body: "<!doctype html><html><body><h1>Bad gateway</h1></body></html>" };
    case "unexpected-json":
      return { contentType: "application/json", body: JSON.stringify({ message: "kinde-testkit sent a JSON body in a shape your client does not expect." }) };
  }
}

function matches(rule: ActiveFailure, method: string, path: string): boolean {
  if (rule.method && rule.method !== method.toUpperCase()) return false;
  if (rule.path.endsWith("*")) return path.startsWith(rule.path.slice(0, -1));
  return rule.path === path;
}

function validate(rule: FailureRule): string[] {
  const problems: string[] = [];
  if (typeof rule.path !== "string" || !rule.path.startsWith("/")) {
    problems.push('"path" must start with "/", for example "/oauth2/token" or "/oauth2/*".');
  } else if (rule.path.startsWith("/testkit/")) {
    problems.push("Failures cannot target /testkit/ control endpoints.");
  }
  if (rule.malformed !== undefined && !MALFORMED_KINDS.includes(rule.malformed)) {
    problems.push(`"malformed" must be one of ${MALFORMED_KINDS.join(", ")}.`);
  }
  const lowest = rule.malformed ? 200 : 400;
  if (rule.status !== undefined && (!Number.isInteger(rule.status) || rule.status < lowest || rule.status > 599)) {
    problems.push(rule.malformed ? '"status" must be between 200 and 599.' : '"status" must be an HTTP error status between 400 and 599.');
  }
  if (rule.delayMs !== undefined && (!Number.isFinite(rule.delayMs) || rule.delayMs < 0 || rule.delayMs > MAX_DELAY_MS)) {
    problems.push(`"delayMs" must be between 0 and ${MAX_DELAY_MS}.`);
  }
  if (rule.times !== undefined && (!Number.isInteger(rule.times) || rule.times < 1)) {
    problems.push('"times" must be a whole number of 1 or more.');
  }
  if (rule.retryAfter !== undefined && (!Number.isInteger(rule.retryAfter) || rule.retryAfter < 0)) {
    problems.push('"retryAfter" must be a whole number of seconds.');
  }
  if (rule.status === undefined && !rule.delayMs && !rule.hang && !rule.malformed) {
    problems.push('Set at least one of "status", "delayMs", "hang" or "malformed".');
  }
  return problems;
}
