import process from "node:process";
import { spawnSync } from "node:child_process";
import { buildToolEnv, workspaceRoot } from "./toolchain.mjs";

const args = process.argv.slice(2);
const cargo = process.platform === "win32"
  ? `${process.env.USERPROFILE}\\.cargo\\bin\\cargo.exe`
  : "cargo";

const result = spawnSync(cargo, args, {
  cwd: workspaceRoot,
  env: buildToolEnv(),
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Failed to start cargo: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
