import { homedir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "../core/executable.js";

import {
  runContainedProcess,
  type ContainedProcessResult,
} from "../transport/contained-process.js";

export function resolveCuaDriverCommand(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.UNICLI_CUA_DRIVER_COMMAND?.trim();
  if (explicit) return explicit;
  const windows = process.platform === "win32";
  const binary = windows ? "cua-driver.exe" : "cua-driver";
  const onPath = findExecutable(binary, env);
  if (onPath) return onPath;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const directory =
    env.CUA_DRIVER_RS_INSTALL_DIR ??
    env.CUA_DRIVER_BIN_DIR ??
    (windows
      ? join(
          env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
          "Programs",
          "Cua",
          "cua-driver",
          "bin",
        )
      : join(home, ".local", "bin"));
  const installed = join(directory, binary);
  return installed;
}

export function parseCuaDriverArgs(
  value: string | undefined,
): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (!value?.trim()) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? { ok: true, value: parsed }
      : {
          ok: false,
          reason: "UNICLI_CUA_DRIVER_ARGS must be a JSON array of strings",
        };
  } catch (error) {
    return {
      ok: false,
      reason: `UNICLI_CUA_DRIVER_ARGS is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function cuaDriverInstallerUrl(
  platform: NodeJS.Platform = process.platform,
): string {
  return `https://cua.ai/driver/install.${platform === "win32" ? "ps1" : "sh"}`;
}

export async function installCuaDriver(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<ContainedProcessResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (
    !["darwin", "linux", "win32"].includes(platform) ||
    !["arm64", "x64"].includes(arch)
  ) {
    throw new Error(
      `Cua Driver has no official binary for ${platform}/${arch}`,
    );
  }
  const timeout = AbortSignal.timeout(300_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  const response = await fetch(cuaDriverInstallerUrl(platform), { signal });
  if (!response.ok)
    throw new Error(
      `Cua Driver installer download returned HTTP ${response.status}`,
    );
  const script = await response.text();
  signal.throwIfAborted();
  // The upstream installer owns release selection, signature checks, atomic replacement, and retry cleanup.
  const windows = platform === "win32";
  const env = options.env ?? process.env;
  const installed = await runContainedProcess(
    windows ? "powershell.exe" : "/bin/bash",
    windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "& ([scriptblock]::Create([Console]::In.ReadToEnd())) -NoAutoStart -NoPathUpdate",
        ]
      : ["-s", "--", "--no-modify-path"],
    { input: script, env, signal },
  );
  if (installed.exitCode !== 0) return installed;
  const version = await runContainedProcess(
    resolveCuaDriverCommand(env),
    ["--version"],
    {
      env,
      signal,
      timeoutMs: 5_000,
    },
  );
  return version.exitCode === 0 ? installed : version;
}
