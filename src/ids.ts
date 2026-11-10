import { createHash } from "node:crypto";

const counters = new Map<string, number>();

export function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

export function nextSequence(prefix: string): number {
  const next = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, next);
  return next;
}

export function resetSequences(): void {
  counters.clear();
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function titleCase(value: string): string {
  return value
    .replace(/^org_/, "")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
