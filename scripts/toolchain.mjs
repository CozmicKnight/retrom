import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(scriptDir, "..");
const minimumNodeMajor = 24;

export function pathEntries() {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function withIfExists(entries, candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return entries;
  }

  if (!entries.includes(candidate)) {
    entries.unshift(candidate);
  }

  return entries;
}

export function buildToolEnv(extra = {}) {
  const entries = pathEntries();
  const userProfile = process.env.USERPROFILE ?? "";
  const homeDir = process.env.HOME ?? userProfile;
  const windowsCargoDefaults =
    process.platform === "win32"
      ? {
          CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? "1",
          CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
        }
      : {};

  withIfExists(entries, path.join(homeDir, ".cargo", "bin"));
  withIfExists(entries, path.join(userProfile, ".cargo", "bin"));
  withIfExists(entries, "C:\\Program Files\\CMake\\bin");
  withIfExists(entries, "C:\\Strawberry\\perl\\bin");
  withIfExists(entries, "C:\\Program Files\\Strawberry\\perl\\bin");

  const protoc = resolveProtoc(entries, userProfile);

  return {
    ...process.env,
    ...windowsCargoDefaults,
    ...extra,
    PATH: entries.join(path.delimiter),
    ...(protoc ? { PROTOC: protoc } : {}),
  };
}

export function resolvePreferredNode() {
  const currentVersion = process.versions.node;
  const currentMajor = nodeMajor(currentVersion);
  if (currentMajor >= minimumNodeMajor) {
    return {
      ok: true,
      command: process.execPath,
      version: currentVersion,
      source: "node",
      current: true,
    };
  }

  const node24 = findOnPath("node-24", pathEntries());
  if (!node24) {
    return {
      ok: false,
      message: [
        `Node ${minimumNodeMajor}+ is required.`,
        `Detected \`node\` ${currentVersion}.`,
        "No `node-24` executable was found on PATH.",
        "Install Node 24, or provide a `node-24` binary/symlink for this repo to use.",
      ].join("\n"),
    };
  }

  const node24Version = probeVersion(node24);
  if (!node24Version.ok) {
    return {
      ok: false,
      message: [
        `Node ${minimumNodeMajor}+ is required.`,
        `Detected \`node\` ${currentVersion}.`,
        `Found \`node-24\` at ${node24}, but could not verify its version.`,
        node24Version.message,
      ].join("\n"),
    };
  }

  const node24Major = nodeMajor(node24Version.version);
  if (node24Major < minimumNodeMajor) {
    return {
      ok: false,
      message: [
        `Node ${minimumNodeMajor}+ is required.`,
        `Detected \`node\` ${currentVersion}.`,
        `Detected \`node-24\` ${node24Version.version}.`,
        "`node-24` also does not satisfy the minimum version requirement.",
      ].join("\n"),
    };
  }

  return {
    ok: true,
    command: node24,
    version: node24Version.version,
    source: "node-24",
    current: false,
  };
}

function nodeMajor(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

function probeVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    return {
      ok: false,
      message: `Failed to execute \`${command} --version\`: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `\`${command} --version\` exited with status ${result.status ?? 1}.`,
    };
  }

  const version = (result.stdout ?? result.stderr ?? "").trim().replace(/^v/, "");
  if (!version) {
    return {
      ok: false,
      message: `\`${command} --version\` did not return a version string.`,
    };
  }

  return {
    ok: true,
    version,
  };
}

function resolveProtoc(entries, userProfile) {
  if (process.env.PROTOC && fs.existsSync(process.env.PROTOC)) {
    return process.env.PROTOC;
  }

  const shellResolved = findOnPath("protoc", entries);
  if (shellResolved) {
    return shellResolved;
  }

  const wingetBin = path.join(
    userProfile,
    "AppData",
    "Local",
    "Microsoft",
    "WinGet",
    "Links",
    "protoc.exe",
  );
  if (fs.existsSync(wingetBin)) {
    return wingetBin;
  }

  const wingetPackagesDir = path.join(
    userProfile,
    "AppData",
    "Local",
    "Microsoft",
    "WinGet",
    "Packages",
  );
  if (fs.existsSync(wingetPackagesDir)) {
    const result = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "where", "protoc"],
      {
        encoding: "utf8",
        shell: false,
      },
    );

    if (result.status === 0) {
      const candidate = (result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.toLowerCase().endsWith("\\protoc.exe") && fs.existsSync(line));
      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

function findOnPath(command, entries) {
  const pathExt =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  for (const entry of entries) {
    for (const ext of pathExt) {
      const candidate = path.join(
        entry,
        process.platform === "win32" ? `${command}${ext.toLowerCase()}` : command,
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
