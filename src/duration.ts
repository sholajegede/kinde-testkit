import { TestkitError } from "./errors.js";
import type { Duration } from "./types.js";

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function toSeconds(value: Duration | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw invalid(String(value));
    return Math.floor(value);
  }
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) {
    if (/^\d+$/.test(value.trim())) return Number(value.trim());
    throw invalid(value);
  }
  return Number(match[1]) * UNITS[match[2] as string]!;
}

function invalid(value: string): TestkitError {
  return new TestkitError(
    "INVALID_DURATION",
    `"${value}" is not a valid duration. Use seconds (3600) or a number with s, m, h or d ("15m", "1h").`,
  );
}
