// Fails the build when a file that package.json exports or bins is missing from dist.
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const files = new Set(Object.values(pkg.bin ?? {}));
const walk = (value) => {
  if (typeof value === "string") files.add(value);
  else if (value && typeof value === "object") Object.values(value).forEach(walk);
};
walk(pkg.exports);
const missing = [...files].filter((file) => !existsSync(new URL(`../${file}`, import.meta.url)));
if (missing.length > 0) {
  console.error(`The build is missing files that package.json points to:\n${missing.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`All ${files.size} exported files are in dist.`);
