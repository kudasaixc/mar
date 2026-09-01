import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = join(process.cwd(), "dist", "test");
const files = readdirSync(directory)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join(directory, file));

if (!files.length) {
  console.error(`No compiled tests found in ${directory}`);
  process.exit(1);
}

const coverage = process.argv.includes("--coverage") ? ["--experimental-test-coverage"] : [];
const result = spawnSync(process.execPath, ["--test", ...coverage, ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
