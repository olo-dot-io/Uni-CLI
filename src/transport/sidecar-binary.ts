/**
 * @owner   src/transport/sidecar-binary.ts
 * @does    Resolve native desktop sidecar executables from env, optional packages, user installs, or PATH.
 * @needs   host platform, arch, env, package resolver, filesystem probe
 * @feeds   desktop UIA and AT-SPI transports, compute doctor
 * @breaks  Wrong platform path resolution prevents native desktop automation startup.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SidecarName = "unicli-uia" | "unicli-atspi";

export interface ResolvedSidecarBinary {
  command: string;
  source: "env" | "package" | "user" | "path";
  packageName?: string;
}

interface ResolveSidecarOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  requireResolve?: (id: string) => string;
  homeDir?: string;
}

export function resolveSidecarBinary(
  name: SidecarName,
  opts: ResolveSidecarOptions = {},
): ResolvedSidecarBinary {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const hostArch = opts.arch ?? process.arch;
  const exists = opts.exists ?? existsSync;
  const requireResolve = opts.requireResolve ?? require.resolve;
  const packageName = packageNameForSidecar(name, platform, hostArch);

  const override = env[envVarForSidecar(name)];
  if (override) {
    return { command: override, source: "env", packageName };
  }

  if (packageName) {
    const command = resolvePackageCommand(
      name,
      platform,
      packageName,
      requireResolve,
    );
    if (command) {
      return { command, source: "package", packageName };
    }
  }

  const userCommand = joinPathForPlatform(
    platform,
    opts.homeDir ?? homedir(),
    ".unicli",
    "sidecars",
    executableName(name, platform),
  );
  if (exists(userCommand)) {
    return { command: userCommand, source: "user", packageName };
  }

  return {
    command: executableName(name, platform),
    source: "path",
    packageName,
  };
}

export function packageNameForSidecar(
  name: SidecarName,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const normalizedArch = arch === "x64" || arch === "arm64" ? arch : undefined;
  if (!normalizedArch) return undefined;
  if (name === "unicli-uia" && platform === "win32") {
    return `@zenalexa/unicli-uia-win32-${normalizedArch}`;
  }
  if (name === "unicli-atspi" && platform === "linux") {
    return `@zenalexa/unicli-atspi-linux-${normalizedArch}`;
  }
  return undefined;
}

function envVarForSidecar(name: SidecarName): string {
  return name === "unicli-uia" ? "UNICLI_UIA_SIDECAR" : "UNICLI_ATSPI_SIDECAR";
}

function executableName(name: SidecarName, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

function resolvePackageCommand(
  name: SidecarName,
  platform: NodeJS.Platform,
  packageName: string,
  requireResolve: (id: string) => string,
): string | undefined {
  try {
    const pkgJson = requireResolve(`${packageName}/package.json`);
    return joinPathForPlatform(
      platform,
      dirnameForPlatform(platform, pkgJson),
      executableName(name, platform),
    );
  } catch {
    return undefined;
  }
}

function dirnameForPlatform(platform: NodeJS.Platform, value: string): string {
  return platform === "win32" ? win32.dirname(value) : posix.dirname(value);
}

function joinPathForPlatform(
  platform: NodeJS.Platform,
  ...segments: string[]
): string {
  return platform === "win32"
    ? win32.join(...segments)
    : posix.join(...segments);
}
