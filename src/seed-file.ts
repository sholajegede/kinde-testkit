import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { TestkitError } from "./errors.js";
import type { TestkitSeed } from "./seed.js";

/** Files `kinde-testkit start` looks for, in this order, when no --seed is given. */
export const DEFAULT_SEED_FILES = [
  "kinde-testkit.json",
  "kinde-testkit.yaml",
  "kinde-testkit.yml",
  "kinde-testkit.ts",
  "kinde-testkit.mts",
  "kinde-testkit.js",
  "kinde-testkit.mjs",
];

export function findSeedFile(directory = "."): string | undefined {
  return DEFAULT_SEED_FILES.map((name) => resolve(directory, name)).find((path) => existsSync(path));
}

/**
 * Reads a seed from JSON, YAML, or a JavaScript or TypeScript module.
 * A module exports the seed as its default export or as `seed`.
 * TypeScript files need a Node version that runs TypeScript (22.18 or later).
 */
export async function loadSeedFile(path: string): Promise<TestkitSeed> {
  const file = resolve(path);
  const extension = extname(file).toLowerCase();
  let value: unknown;
  try {
    if (extension === ".yaml" || extension === ".yml") {
      value = parseYaml(readFileSync(file, "utf8"));
    } else if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) {
      const module = (await import(pathToFileURL(file).href)) as { default?: unknown; seed?: unknown };
      value = module.seed ?? module.default;
      if (value && typeof value === "object" && "default" in value && !("users" in value)) {
        value = (value as { default: unknown }).default;
      }
    } else {
      value = JSON.parse(readFileSync(file, "utf8"));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = [message];
    if (extension.endsWith("ts") && /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(message)) {
      details.push("Your Node version cannot run TypeScript files. Use Node 22.18 or later, or a .js, .json or .yaml seed.");
    }
    throw new TestkitError("SEED_INVALID", `Could not read the seed file at ${file}.`, details);
  }
  if (value === null || value === undefined) value = {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TestkitError("SEED_INVALID", `The seed file at ${file} must contain an object with users, organizations and memberships.`);
  }
  return value as TestkitSeed;
}
