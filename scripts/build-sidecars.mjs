#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  {
    target: "x86_64-pc-windows-msvc",
    crate: "unicli-uia",
    binary: "unicli-uia.exe",
    packageDir: "packages/sidecars/unicli-uia-win32-x64",
  },
  {
    target: "aarch64-pc-windows-msvc",
    crate: "unicli-uia",
    binary: "unicli-uia.exe",
    packageDir: "packages/sidecars/unicli-uia-win32-arm64",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    crate: "unicli-atspi",
    binary: "unicli-atspi",
    packageDir: "packages/sidecars/unicli-atspi-linux-x64",
  },
  {
    target: "aarch64-unknown-linux-gnu",
    crate: "unicli-atspi",
    binary: "unicli-atspi",
    packageDir: "packages/sidecars/unicli-atspi-linux-arm64",
  },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--skip-build");
const selectedTarget = readArg("--target");

const selected = selectedTarget
  ? TARGETS.filter((entry) => entry.target === selectedTarget)
  : TARGETS;

if (selected.length === 0) {
  console.error(`Unknown sidecar target: ${selectedTarget}`);
  process.exit(2);
}

for (const entry of selected) {
  const output = join(
    ROOT,
    "target",
    entry.target,
    "release-sidecar",
    entry.binary,
  );
  const dest = join(ROOT, entry.packageDir, entry.binary);

  if (!skipBuild) {
    run("cargo", [
      "build",
      "--target",
      entry.target,
      "--profile",
      "release-sidecar",
      "-p",
      entry.crate,
    ]);
  }

  if (dryRun) {
    console.log(`[dry-run] copy ${relative(output)} -> ${relative(dest)}`);
    continue;
  }

  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(output, dest);
  if (!entry.binary.endsWith(".exe")) chmodSync(dest, 0o755);
  console.log(`copied ${relative(output)} -> ${relative(dest)}`);
}

function run(command, commandArgs) {
  console.log(`$ ${command} ${commandArgs.join(" ")}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readArg(name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function relative(path) {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}
