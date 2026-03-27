import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(scriptDir, "..");

function pathEntries() {
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
  const windowsCargoDefaults =
    process.platform === "win32"
      ? {
          CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? "1",
          CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
        }
      : {};

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
  const pathExt = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean);

  for (const entry of entries) {
    for (const ext of ["", ...pathExt]) {
      const candidate = path.join(entry, `${command}${ext.toLowerCase()}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
