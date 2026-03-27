import process from "node:process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildToolEnv, workspaceRoot } from "./toolchain.mjs";

const args = process.argv.slice(2);
const clientRoot = path.join(workspaceRoot, "packages", "client");
const tauriCmd = process.platform === "win32"
  ? path.join(workspaceRoot, "node_modules", ".bin", "tauri.CMD")
  : path.join(workspaceRoot, "node_modules", ".bin", "tauri");

const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", tauriCmd, ...args], {
      cwd: clientRoot,
      env: buildToolEnv(),
      stdio: "inherit",
      shell: false,
    })
  : spawnSync(tauriCmd, args, {
      cwd: clientRoot,
      env: buildToolEnv(),
      stdio: "inherit",
      shell: false,
    });

if (result.error) {
  console.error(`Failed to start Tauri CLI: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 0);
