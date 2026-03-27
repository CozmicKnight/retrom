import process from "node:process";
import { spawnSync } from "node:child_process";
import { buildToolEnv, resolveCorepackInvocation, workspaceRoot } from "./toolchain.mjs";

const currentDir = process.cwd();
const corepackHome = process.env.COREPACK_HOME ?? `${workspaceRoot}\\.corepack`;
const args = process.argv.slice(2);
const corepack = resolveCorepackInvocation("pnpm", ...args);

if (!corepack.ok) {
  console.error(corepack.message);
  process.exit(1);
}

const result = spawnSync(corepack.command, corepack.args, {
  cwd: currentDir,
  env: buildToolEnv({
    COREPACK_HOME: corepackHome,
    NX_NO_CLOUD: process.env.NX_NO_CLOUD ?? "true",
  }),
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  console.error(`Failed to start pnpm via corepack using ${corepack.source}: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
