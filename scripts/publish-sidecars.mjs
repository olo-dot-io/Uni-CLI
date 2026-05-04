#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIRS = [
  "packages/sidecars/unicli-uia-win32-x64",
  "packages/sidecars/unicli-uia-win32-arm64",
  "packages/sidecars/unicli-atspi-linux-x64",
  "packages/sidecars/unicli-atspi-linux-arm64",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipBinaryCheck = args.includes("--skip-binary-check");
const selectedName = readArg("--package");

for (const dir of PACKAGE_DIRS) {
  const fullDir = join(ROOT, dir);
  const pkg = JSON.parse(readFileSync(join(fullDir, "package.json"), "utf8"));
  if (selectedName && pkg.name !== selectedName) continue;

  const binary = Object.values(pkg.bin ?? {})[0];
  if (!skipBinaryCheck && binary && !existsSync(join(fullDir, binary))) {
    console.error(`missing sidecar binary for ${pkg.name}: ${dir}/${binary}`);
    process.exit(66);
  }

  run(
    "npm",
    [
      "publish",
      "--access",
      "public",
      "--provenance",
      ...(dryRun ? ["--dry-run"] : []),
    ],
    fullDir,
  );
}

function run(command, commandArgs, cwd) {
  console.log(`(${relative(cwd)}) $ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
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
