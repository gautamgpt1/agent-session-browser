import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const generated = ["dist", "test-results", "playwright-report", "coverage", "tests/.tmp"];

for (const relative of generated) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing path outside workspace: ${target}`);
  if (!fs.existsSync(target)) continue;
  const resolved = fs.realpathSync(target);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing resolved path outside workspace: ${resolved}`);
  fs.rmSync(target, { recursive: true, force: true });
  process.stdout.write(`Removed ${relative}\n`);
}
