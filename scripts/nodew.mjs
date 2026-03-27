import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolvePreferredNode } from "./toolchain.mjs";

const args = process.argv.slice(2);
const [script, ...scriptArgs] = args;

if (!script) {
  console.error("Usage: node ./scripts/nodew.mjs <script> [args...]");
  process.exit(1);
}

const preferredNode = resolvePreferredNode();
if (!preferredNode.ok) {
  console.error(preferredNode.message);
  process.exit(1);
}

const result = spawnSync(preferredNode.command, [script, ...scriptArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Failed to start ${preferredNode.source}: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
