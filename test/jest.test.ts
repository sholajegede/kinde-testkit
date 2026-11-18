import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");

// Builds the package, then runs a real Jest project against the CommonJS build.
describe("kinde-testkit/jest", () => {
  beforeAll(async () => {
    await run(process.execPath, [join(root, "node_modules", "tsup", "dist", "cli-default.js"), "--silent"], { cwd: root });
  }, 120_000);

  it("starts a testkit per file and mints verified tokens under Jest", async () => {
    const jest = join(root, "node_modules", "jest", "bin", "jest.js");
    const { stdout, stderr } = await run(process.execPath, [jest, "--config", join(root, "test", "fixtures", "jest", "jest.config.cjs"), "--ci"], {
      cwd: root,
    });
    expect(`${stdout}${stderr}`).toMatch(/Tests:\s+3 passed, 3 total/);
  }, 120_000);
});
