import process from "node:process";
import { spawnSync } from "node:child_process";
import { buildToolEnv, workspaceRoot } from "./toolchain.mjs";

const currentDir = process.cwd();
const corepackHome = process.env.COREPACK_HOME ?? `${workspaceRoot}\\.corepack`;
const args = process.argv.slice(2);
const isWindows = process.platform === "win32";

const result = isWindows
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "corepack", "pnpm", ...args], {
      cwd: currentDir,
      env: buildToolEnv({
        COREPACK_HOME: corepackHome,
        NX_NO_CLOUD: process.env.NX_NO_CLOUD ?? "true",
      }),
      stdio: "inherit",
      shell: false,
    })
  : spawnSync("corepack", ["pnpm", ...args], {
      cwd: currentDir,
      env: buildToolEnv({
        COREPACK_HOME: corepackHome,
        NX_NO_CLOUD: process.env.NX_NO_CLOUD ?? "true",
      }),
      stdio: "inherit",
      shell: false,
    });

if (result.error) {
  console.error(`Failed to start pnpm via corepack: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
