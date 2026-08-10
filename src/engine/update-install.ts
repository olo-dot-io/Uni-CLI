/**
 * @owner       src::engine::update-install
 * @does        Detects the persistent Uni-CLI package manager and executes one exact-version global install.
 * @needs       node child_process and the installed module path
 * @feeds       explicit upgrades and the detached automatic-update worker
 * @breaks      A false-positive install-method match can replace an unrelated global package.
 * @invariants  Ephemeral and source-checkout paths never auto-detect; installers receive an exact version without a shell.
 * @side-effects May spawn npm, pnpm, or Bun and capture bounded output.
 * @perf        Detection is linear in the short module path; install duration belongs to the package manager.
 * @concurrency The selected package manager owns its global installation lock.
 * @test        tests/unit/commands/upgrade.test.ts and tests/unit/update-auto.test.ts
 * @stability   internal shared update boundary
 * @since       2026-08-10
 */

import { spawn } from "node:child_process";

export type UpdatePackageManager = "npm" | "pnpm" | "bun";

export interface InstallResult {
  exitCode: number;
  output: string;
}

export function detectUpdatePackageManager(
  scriptPath: string,
): UpdatePackageManager | undefined {
  const normalized = scriptPath.replaceAll("\\", "/").toLowerCase();
  if (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/pnpm/dlx/") ||
    normalized.includes("/.bun/install/cache/")
  ) {
    return undefined;
  }
  if (!normalized.includes("/node_modules/@zenalexa/unicli/")) {
    return undefined;
  }
  if (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/pnpm/global/")
  ) {
    return "pnpm";
  }
  if (normalized.includes("/.bun/install/global/")) return "bun";
  return "npm";
}

export function updateInstallCommand(
  manager: UpdatePackageManager,
  latest: string,
): { command: string; args: string[]; display: string } {
  const specifier = `@zenalexa/unicli@${latest}`;
  if (manager === "pnpm") {
    return {
      command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
      args: ["add", "--global", specifier],
      display: `pnpm add --global ${specifier}`,
    };
  }
  if (manager === "bun") {
    return {
      command: process.platform === "win32" ? "bun.exe" : "bun",
      args: ["install", "--global", specifier],
      display: `bun install --global ${specifier}`,
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["install", "--global", specifier],
    display: `npm install --global ${specifier}`,
  };
}

export async function runPackageManagerInstall(
  manager: UpdatePackageManager,
  latest: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstallResult> {
  const plan = updateInstallCommand(manager, latest);
  return await new Promise<InstallResult>((resolve) => {
    const child = spawn(plan.command, plan.args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (result: InstallResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const append = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-4000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      finish({ exitCode: 1, output: error.message });
    });
    child.once("close", (code) => {
      finish({ exitCode: code ?? 1, output: output.trim() });
    });
  });
}
