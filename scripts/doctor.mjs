import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const powerShellPath = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const osRelease = isLinux ? readOsRelease() : {};

function readOsRelease() {
  try {
    const contents = fs.readFileSync("/etc/os-release", "utf8");
    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          const key = line.slice(0, index);
          const value = line.slice(index + 1).replace(/^"/, "").replace(/"$/, "");
          return [key, value];
        }),
    );
  } catch {
    return {};
  }
}

function linuxFamily() {
  const ids = [osRelease.ID, ...(osRelease.ID_LIKE ?? "").split(" ")].filter(Boolean).map((value) => value.toLowerCase());
  if (ids.includes("fedora") || ids.includes("rhel") || ids.includes("centos")) {
    return "fedora";
  }

  if (ids.includes("debian") || ids.includes("ubuntu")) {
    return "debian";
  }

  if (ids.includes("arch")) {
    return "arch";
  }

  return "generic";
}

function installCommand(tool) {
  if (isWindows) {
    return windowsInstallCommand(tool);
  }

  if (isMac) {
    return macInstallCommand(tool);
  }

  if (isLinux) {
    return linuxInstallCommand(tool);
  }

  return null;
}

function windowsInstallCommand(tool) {
  const commands = {
    rustup: "winget install Rustlang.Rustup",
    protoc: "winget install protobuf",
    cmake: "winget install Kitware.CMake",
    perl: "winget install StrawberryPerl.StrawberryPerl",
    webview2: "winget install Microsoft.EdgeWebView2Runtime",
    msvc: "winget install Microsoft.VisualStudio.2022.BuildTools",
  };

  return commands[tool] ?? null;
}

function macInstallCommand(tool) {
  const commands = {
    rustup: "brew install rustup-init && rustup-init",
    protoc: "brew install protobuf",
    cmake: "brew install cmake",
    openssl: "brew install openssl",
    "pkg-config": "brew install pkg-config",
    corepack: "brew install node@24",
  };

  return commands[tool] ?? null;
}

function linuxInstallCommand(tool) {
  const family = linuxFamily();

  if (family === "fedora") {
    const commands = {
      rustup: "sudo dnf install rustup",
      protoc: "sudo dnf install protobuf-compiler",
      cmake: "sudo dnf install cmake",
      openssl: "sudo dnf install openssl-devel",
      "pkg-config": "sudo dnf install pkgconf-pkg-config",
      corepack: "sudo dnf install nodejs24",
      glib: "sudo dnf install glib2-devel",
      gobject: "sudo dnf install glib2-devel",
      gio: "sudo dnf install glib2-devel",
      gtk3: "sudo dnf install gtk3-devel",
      webkit2gtk: "sudo dnf install webkit2gtk4.1-devel",
      javascriptcoregtk: "sudo dnf install javascriptcoregtk4.1-devel",
      libsoup3: "sudo dnf install libsoup3-devel",
    };

    return commands[tool] ?? null;
  }

  if (family === "debian") {
    const commands = {
      rustup: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
      protoc: "sudo apt-get install protobuf-compiler",
      cmake: "sudo apt-get install cmake",
      openssl: "sudo apt-get install libssl-dev",
      "pkg-config": "sudo apt-get install pkg-config",
      corepack: "sudo apt-get install nodejs npm",
      glib: "sudo apt-get install libglib2.0-dev",
      gobject: "sudo apt-get install libglib2.0-dev",
      gio: "sudo apt-get install libglib2.0-dev",
      gtk3: "sudo apt-get install libgtk-3-dev",
      webkit2gtk: "sudo apt-get install libwebkit2gtk-4.1-dev",
      javascriptcoregtk: "sudo apt-get install libjavascriptcoregtk-4.1-dev",
      libsoup3: "sudo apt-get install libsoup-3.0-dev",
    };

    return commands[tool] ?? null;
  }

  if (family === "arch") {
    const commands = {
      rustup: "sudo pacman -S rustup",
      protoc: "sudo pacman -S protobuf",
      cmake: "sudo pacman -S cmake",
      openssl: "sudo pacman -S openssl",
      "pkg-config": "sudo pacman -S pkgconf",
      corepack: "sudo pacman -S nodejs npm",
      glib: "sudo pacman -S glib2",
      gobject: "sudo pacman -S glib2",
      gio: "sudo pacman -S glib2",
      gtk3: "sudo pacman -S gtk3",
      webkit2gtk: "sudo pacman -S webkit2gtk-4.1",
      javascriptcoregtk: "sudo pacman -S webkit2gtk-4.1",
      libsoup3: "sudo pacman -S libsoup3",
    };

    return commands[tool] ?? null;
  }

  const commands = {
    rustup: "Install rustup from https://rustup.rs/",
    protoc: "Install protoc via your distro package manager",
    cmake: "Install cmake via your distro package manager",
    openssl: "Install OpenSSL development headers via your distro package manager",
    "pkg-config": "Install pkg-config via your distro package manager",
    corepack: "Install Node.js 24 and corepack via your distro package manager",
    glib: "Install glib-2.0 development files via your distro package manager",
    gobject: "Install gobject-2.0 development files via your distro package manager",
    gio: "Install gio-2.0 development files via your distro package manager",
    gtk3: "Install GTK 3 development files via your distro package manager",
    webkit2gtk: "Install WebKitGTK 4.1 development files via your distro package manager",
    javascriptcoregtk: "Install JavaScriptCoreGTK 4.1 development files via your distro package manager",
    libsoup3: "Install libsoup3 development files via your distro package manager",
  };

  return commands[tool] ?? null;
}

function compareVersions(a, b) {
  const aParts = a.split(".").map(Number);
  const bParts = b.split(".").map(Number);
  const max = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < max; index += 1) {
    const left = aParts[index] ?? 0;
    const right = bParts[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  return 0;
}

function run(command, args) {
  const isWindowsScript = isWindows && [".cmd", ".bat"].includes(path.extname(command).toLowerCase());
  const result = isWindowsScript
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
        cwd: rootDir,
        encoding: "utf8",
        shell: false,
      })
    : spawnSync(command, args, {
        cwd: rootDir,
        encoding: "utf8",
        shell: false,
      });

  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  const output = stdout || stderr;

  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error,
    output,
  };
}

function runPowerShell(command) {
  if (!isWindows || !fs.existsSync(powerShellPath)) {
    return {
      ok: false,
      status: 1,
      error: new Error("PowerShell is unavailable"),
      output: "",
    };
  }

  return spawnSync(powerShellPath, ["-NoProfile", "-Command", command], {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });
}

function findExecutable(name) {
  const pathEntries = getSearchPathEntries();

  if (isWindows) {
    const pathExt = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
      .split(";")
      .filter(Boolean);

    const candidateNames = path.extname(name)
      ? [name]
      : [
          ...pathExt.map((ext) => `${name}${ext.toLowerCase()}`),
          ...pathExt.map((ext) => `${name}${ext}`),
          name,
        ];

    for (const entry of pathEntries) {
      for (const candidate of candidateNames) {
        const fullPath = path.join(entry, candidate);
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      }
    }

    if (name.toLowerCase() === "protoc") {
      return findWindowsProtoc();
    }

    return null;
  }

  for (const entry of pathEntries) {
    const fullPath = path.join(entry, name);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}

function findWindowsProtoc() {
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "where", "protoc"], {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });

  if (result.status === 0) {
    const fromWhere = (result.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.toLowerCase().endsWith("\\protoc.exe") && fs.existsSync(line));

    if (fromWhere) {
      return fromWhere;
    }
  }

  return findWindowsCommand("protoc");
}

function findWindowsCommand(name) {
  const result = runPowerShell(
    `$command = Get-Command -Name '${name}' -ErrorAction SilentlyContinue; if ($command) { $command.Source }`,
  );

  const resolved = (result.stdout ?? "").trim();
  return resolved && fs.existsSync(resolved) ? resolved : null;
}

function findFirstExisting(paths) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function probeMsvcBuildTools() {
  const vswherePath = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";

  if (fs.existsSync(vswherePath)) {
    const result = run(vswherePath, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ]);

    const installationPath = result.output.trim();
    if (result.ok && installationPath) {
      return {
        name: "msvc",
        required: false,
        ok: true,
        output: "",
        detail: `Detected Visual Studio Build Tools at ${installationPath}`,
      };
    }
  }

  return {
    name: "msvc",
    required: false,
    ok: false,
    output: "",
    detail: "Microsoft C++ build tools were not detected. Desktop builds need them.",
    fix: installCommand("msvc"),
    manualFix: "Install Visual Studio 2022 Build Tools with the C++ workload, then reopen your shell.",
  };
}

function probeWebView2Runtime() {
  const userProfile = process.env.USERPROFILE ?? "";
  const runtimePath = findFirstExisting([
    "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe",
    "C:\\Program Files\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe",
    path.join(
      userProfile,
      "AppData",
      "Local",
      "Microsoft",
      "EdgeWebView",
      "Application",
      "msedgewebview2.exe",
    ),
  ]);

  if (runtimePath) {
    return {
      name: "webview2",
      required: false,
      ok: true,
      output: "",
      detail: `Detected WebView2 runtime at ${runtimePath}`,
    };
  }

  return {
    name: "webview2",
    required: false,
    ok: false,
    output: "",
    detail: "Microsoft Edge WebView2 runtime was not detected. Desktop builds and runtime need it.",
    fix: installCommand("webview2"),
    manualFix: "Install the Evergreen WebView2 Runtime from Microsoft.",
  };
}

function getSearchPathEntries() {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);

  if (!isWindows) {
    return entries;
  }

  const userProfile = process.env.USERPROFILE ?? "";
  const windowsExtras = [
    path.join(userProfile, ".cargo", "bin"),
    path.join(userProfile, "AppData", "Local", "Microsoft", "WinGet", "Links"),
    "C:\\Program Files\\CMake\\bin",
    "C:\\Strawberry\\perl\\bin",
    "C:\\Program Files\\Strawberry\\perl\\bin",
  ];

  for (const extra of windowsExtras) {
    if (extra && fs.existsSync(extra) && !entries.includes(extra)) {
      entries.unshift(extra);
    }
  }

  return entries;
}

function probeBinary(name, args = ["--version"]) {
  const executable = findExecutable(name);
  if (!executable) {
    return {
      name,
      ok: false,
      output: "",
      detail: "Not found on PATH",
    };
  }

  if (isWindows && [".cmd", ".bat"].includes(path.extname(executable).toLowerCase())) {
    return {
      name,
      ok: true,
      output: "",
      detail: `Found at ${executable}`,
    };
  }

  const result = run(executable, args);

  if (result.error?.code === "EPERM") {
    return {
      name,
      ok: true,
      output: "",
      detail: `Found at ${executable}, but version probing is blocked in this environment`,
    };
  }

  return {
    name,
    ok: result.ok,
    output: result.output,
    detail: result.error?.message ?? result.output ?? `Found at ${executable}`,
  };
}

function probePkgConfigPackage(name, version = null) {
  const pkgConfig = findExecutable("pkg-config");
  if (!pkgConfig) {
    return {
      name,
      ok: false,
      output: "",
      detail: "pkg-config is not available, so this system library could not be checked.",
    };
  }

  const args = ["--exists", name];
  if (version) {
    args.push(`${name} >= ${version}`);
  }

  const result = run(pkgConfig, args);
  return {
    name,
    ok: result.ok,
    output: "",
    detail: result.ok
      ? `Detected \`${name}\` via pkg-config.`
      : `The system library \`${name}\` was not found via pkg-config.`,
  };
}

function probeDiskSpace() {
  if (typeof fs.statfsSync !== "function") {
    return null;
  }

  try {
    const stats = fs.statfsSync(rootDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const freeGb = freeBytes / (1024 ** 3);

    return {
      name: "disk",
      required: false,
      ok: freeGb >= 20,
      output: `${freeGb.toFixed(1)} GB free`,
      detail:
        freeGb >= 20
          ? "Free space looks adequate for local Rust/Tauri builds."
          : "Low free space. Windows desktop builds can consume tens of GB in `target` during first-time native compilation.",
    };
  } catch (error) {
    return {
      name: "disk",
      required: false,
      ok: true,
      output: "",
      detail: `Free-space check unavailable: ${error.message}`,
    };
  }
}

const checks = [];
const npmCheck = probeBinary("npm");
const corepackCheck = probeBinary("corepack");
const pnpmCheck = probeBinary("pnpm");
const rustupCheck = probeBinary("rustup");
const rustcCheck = probeBinary("rustc");
const cargoCheck = probeBinary("cargo");
const protocCheck = probeBinary("protoc");
const perlCheck = probeBinary("perl");
const opensslCheck = probeBinary("openssl");
const cmakeCheck = probeBinary("cmake");
const pkgConfigCheck = !isWindows ? probeBinary("pkg-config") : null;
const glibCheck = isLinux ? probePkgConfigPackage("glib-2.0", "2.70") : null;
const gobjectCheck = isLinux ? probePkgConfigPackage("gobject-2.0", "2.70") : null;
const gioCheck = isLinux ? probePkgConfigPackage("gio-2.0", "2.70") : null;
const gtk3Check = isLinux ? probePkgConfigPackage("gtk+-3.0") : null;
const webkit2gtkCheck = isLinux ? probePkgConfigPackage("webkit2gtk-4.1") : null;
const javascriptcoregtkCheck = isLinux ? probePkgConfigPackage("javascriptcoregtk-4.1") : null;
const libsoup3Check = isLinux ? probePkgConfigPackage("libsoup-3.0") : null;
const diskCheck = probeDiskSpace();
const msvcCheck = isWindows ? probeMsvcBuildTools() : null;
const webview2Check = isWindows ? probeWebView2Runtime() : null;

const nodeVersion = process.versions.node;
checks.push({
  name: "node",
  required: true,
  ok: compareVersions(nodeVersion, "24.0.0") >= 0,
  output: `v${nodeVersion}`,
  detail:
    compareVersions(nodeVersion, "24.0.0") >= 0
      ? `Detected ${nodeVersion}`
      : `Detected ${nodeVersion}; Retrom requires Node 24 or newer`,
});

checks.push({
  ...npmCheck,
  required: true,
});

checks.push({
  ...corepackCheck,
  required: true,
  fix: installCommand("corepack"),
});

checks.push({
  ...pnpmCheck,
  required: false,
  detail: pnpmCheck.ok
    ? pnpmCheck.detail
    : "Not on PATH. Use `node ./scripts/nodew.mjs ./scripts/pnpmw.mjs ...` or run `npm run bootstrap` first.",
  fix: "npm run bootstrap",
});

checks.push({
  ...rustupCheck,
  required: true,
  fix: installCommand("rustup"),
  manualFix: "Install Rust using rustup from rust-lang.org, then reopen your shell.",
});

checks.push({
  ...rustcCheck,
  required: true,
});

checks.push({
  ...cargoCheck,
  required: true,
});

checks.push({
  ...protocCheck,
  required: false,
  detail: protocCheck.ok
    ? `${protocCheck.detail}. Cargo builds will prefer this before falling back to a packaged protoc binary.`
    : isWindows
      ? "Not on PATH. Cargo builds can fall back to a packaged protoc binary, but installing system protoc is usually faster and more reliable on Windows."
      : "Not on PATH. Cargo builds can fall back to a packaged protoc binary, but a system protoc is usually faster and more reliable.",
  fix: installCommand("protoc"),
  manualFix: "Download a prebuilt `protoc-*-win64.zip`, extract it, and add its `bin` directory to PATH.",
});

checks.push({
  ...opensslCheck,
  required: false,
  detail: opensslCheck.ok
    ? `${opensslCheck.detail}. Set OPENSSL_NO_VENDOR=1 to force the system install.`
    : "Not on PATH. Cargo will use vendored OpenSSL by default.",
  fix: installCommand("openssl"),
});

checks.push({
  ...cmakeCheck,
  required: false,
  detail: cmakeCheck.ok
    ? cmakeCheck.detail
    : "Not on PATH. Some vendored/native Rust dependencies still rely on CMake during source builds.",
  fix: installCommand("cmake"),
  manualFix: "Install CMake from Kitware and reopen your shell.",
});

if (isWindows) {
  checks.push({
    ...perlCheck,
    required: false,
    detail: perlCheck.ok
      ? `${perlCheck.detail}. Vendored OpenSSL should be able to build if MSVC tools are also installed.`
      : "Not on PATH. Vendored OpenSSL on Windows often needs Perl; Strawberry Perl is the usual fix.",
    fix: installCommand("perl"),
    manualFix: "Install Strawberry Perl and reopen your shell.",
  });
}

if (!isWindows) {
  checks.push({
    ...pkgConfigCheck,
    required: false,
    detail: pkgConfigCheck.ok
      ? pkgConfigCheck.detail
      : "Missing. Non-Windows native builds may still need pkg-config and OpenSSL development headers.",
    fix: installCommand("pkg-config"),
  });
}

if (isLinux) {
  checks.push({
    ...glibCheck,
    name: "glib-2.0",
    required: false,
    detail: glibCheck.ok
      ? glibCheck.detail
      : "Missing. Linux desktop/workspace builds need GLib development files.",
    fix: installCommand("glib"),
  });
  checks.push({
    ...gobjectCheck,
    name: "gobject-2.0",
    required: false,
    detail: gobjectCheck.ok
      ? gobjectCheck.detail
      : "Missing. Linux desktop/workspace builds need GObject development files.",
    fix: installCommand("gobject"),
  });
  checks.push({
    ...gioCheck,
    name: "gio-2.0",
    required: false,
    detail: gioCheck.ok
      ? gioCheck.detail
      : "Missing. Linux desktop/workspace builds need GIO development files.",
    fix: installCommand("gio"),
  });
  checks.push({
    ...gtk3Check,
    name: "gtk+-3.0",
    required: false,
    detail: gtk3Check.ok
      ? gtk3Check.detail
      : "Missing. Linux desktop/Tauri builds need GTK 3 development files.",
    fix: installCommand("gtk3"),
  });
  checks.push({
    ...webkit2gtkCheck,
    name: "webkit2gtk-4.1",
    required: false,
    detail: webkit2gtkCheck.ok
      ? webkit2gtkCheck.detail
      : "Missing. Linux desktop/Tauri builds need WebKitGTK 4.1 development files.",
    fix: installCommand("webkit2gtk"),
  });
  checks.push({
    ...javascriptcoregtkCheck,
    name: "javascriptcoregtk-4.1",
    required: false,
    detail: javascriptcoregtkCheck.ok
      ? javascriptcoregtkCheck.detail
      : "Missing. Linux desktop/Tauri builds need JavaScriptCoreGTK 4.1 development files.",
    fix: installCommand("javascriptcoregtk"),
  });
  checks.push({
    ...libsoup3Check,
    name: "libsoup-3.0",
    required: false,
    detail: libsoup3Check.ok
      ? libsoup3Check.detail
      : "Missing. Linux desktop/Tauri builds need libsoup3 development files.",
    fix: installCommand("libsoup3"),
  });
}

if (diskCheck) {
  checks.push(diskCheck);
}

if (msvcCheck) {
  checks.push(msvcCheck);
}

if (webview2Check) {
  checks.push(webview2Check);
}

const missingRequired = checks.filter((check) => check.required && !check.ok);
const missingOptional = checks.filter((check) => !check.required && !check.ok);
const installSuggestions = checks
  .filter((check) => !check.ok && check.fix)
  .map((check) => ({ name: check.name, fix: check.fix }));
const manualSuggestions = checks
  .filter((check) => !check.ok && check.manualFix)
  .map((check) => ({ name: check.name, manualFix: check.manualFix }));

console.log(`Retrom source-install doctor`);
console.log(`Workspace: ${rootDir}`);
console.log(`Platform: ${os.platform()} ${os.release()} (${process.arch})`);
console.log("");

for (const check of checks) {
  const level = check.ok ? "OK " : check.required ? "ERR" : "WARN";
  const suffix = check.output ? ` (${check.output})` : "";
  console.log(`${level} ${check.name}${suffix}`);
  if (check.detail) {
    console.log(`    ${check.detail}`);
  }
}

console.log("");

if (missingRequired.length === 0) {
  console.log("Required tooling looks present for a source install.");
} else {
  console.log("Missing required tooling:");
  for (const check of missingRequired) {
    console.log(`- ${check.name}`);
  }
}

if (missingOptional.length > 0) {
  console.log("");
  console.log("Optional or target-specific gaps:");
  for (const check of missingOptional) {
    console.log(`- ${check.name}: ${check.detail}`);
  }
}

if (installSuggestions.length > 0) {
  console.log("");
  console.log("Suggested install commands:");
  for (const suggestion of installSuggestions) {
    console.log(`- ${suggestion.name}: \`${suggestion.fix}\``);
  }
}

if (manualSuggestions.length > 0) {
  console.log("");
  console.log("Manual install fallbacks:");
  for (const suggestion of manualSuggestions) {
    console.log(`- ${suggestion.name}: ${suggestion.manualFix}`);
  }
}

console.log("");
console.log("Expected install flow from source:");
console.log("1. `npm run bootstrap`");
console.log("2. `npm run doctor`");
console.log("3. `node ./scripts/nodew.mjs ./scripts/pnpmw.mjs nx dev retrom-client-web` for web development");
console.log("4. `node ./scripts/nodew.mjs ./scripts/pnpmw.mjs nx dev retrom-client` for the desktop client");
console.log("5. `node ./scripts/nodew.mjs ./scripts/pnpmw.mjs nx build retrom-client --configuration debug` for a local desktop build");

if (isWindows) {
  console.log("");
  console.log("Windows notes:");
  console.log("- Desktop builds also need Microsoft C++ build tools and the WebView2 runtime.");
  console.log("- PostgreSQL is only needed when running the service without Docker and without `--features embedded_db`.");
  console.log("- Vendored OpenSSL may still need Perl and MSVC build tools.");
}

if (isLinux) {
  console.log("");
  console.log("Linux notes:");
  console.log("- Full workspace and desktop/Tauri builds also need GLib, GTK, WebKitGTK, JavaScriptCoreGTK, and libsoup development packages.");
  console.log("- Server-only builds can skip the desktop GUI packages.");
}
