import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const corepackHome = process.env.COREPACK_HOME ?? path.join(rootDir, ".corepack");
const isWindows = process.platform === "win32";

fs.mkdirSync(corepackHome, { recursive: true });

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (Number.isNaN(nodeMajor) || nodeMajor < 24) {
  fail(`Node ${process.versions.node} detected. Retrom requires Node 24 or newer.`);
}

const install = isWindows
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "corepack", "pnpm", "install"], {
      cwd: rootDir,
      env: {
        ...process.env,
        COREPACK_HOME: corepackHome,
      },
      stdio: "inherit",
      shell: false,
    })
  : spawnSync("corepack", ["pnpm", "install"], {
      cwd: rootDir,
      env: {
        ...process.env,
        COREPACK_HOME: corepackHome,
      },
      stdio: "inherit",
      shell: false,
    });

if (install.error) {
  fail(`Failed to start corepack: ${install.error.message}`);
}

if (install.status !== 0) {
  fail(
    [
      "Bootstrap could not complete `corepack pnpm install`.",
      `COREPACK_HOME was set to ${corepackHome}.`,
      "If this is a fresh machine, confirm outbound access to the npm registry and then rerun `npm run bootstrap`.",
    ].join("\n"),
    install.status ?? 1,
  );
}

console.log("");
console.log("JavaScript dependencies installed.");
console.log("Run `npm run doctor` next to verify the remaining native prerequisites.");
console.log("");
console.log("Use pnpm through the repo wrapper with:");
console.log("node ./scripts/nodew.mjs ./scripts/pnpmw.mjs <command>");
