import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cuaDriverInstallerUrl,
  installCuaDriver,
  parseCuaDriverArgs,
  resolveCuaDriverCommand,
} from "../../src/compute/cua-driver-runtime.js";
import { CuaDriverTransport } from "../../src/transport/adapters/cua-driver.js";
import { createTransportBus } from "../../src/transport/bus.js";

const root = await mkdtemp(join(tmpdir(), "unicli-cua-install-"));
const originalFetch = globalThis.fetch;
const env = {
  ...process.env,
  HOME: root,
  PATH: "/usr/bin:/bin",
  UNICLI_CUA_DRIVER_COMMAND: "",
  CUA_DRIVER_RS_INSTALL_DIR: join(root, ".local", "bin"),
};
const results: Array<{
  scenario: string;
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
}> = [];
let downloads = 0;
let installer = "exit 77";
// REASON: Only the upstream installer download is replaced; the owned installer process, executable discovery, and driver transport execute normally in a temporary home.
globalThis.fetch = async () => {
  downloads += 1;
  return new Response(installer);
};
try {
  try {
    await installCuaDriver({ platform: "freebsd", env });
    results.push({ scenario: "unsupported platform", ok: false });
  } catch {
    results.push({ scenario: "unsupported platform", ok: downloads === 0 });
  }
  const cancelled = new AbortController();
  cancelled.abort(new Error("scenario cancellation"));
  try {
    await installCuaDriver({ env, signal: cancelled.signal });
    results.push({ scenario: "cancel before download", ok: false });
  } catch {
    results.push({ scenario: "cancel before download", ok: downloads === 0 });
  }
  if (process.platform === "darwin" || process.platform === "linux") {
    const failed = await installCuaDriver({ env });
    results.push({
      scenario: "preserve installer failure",
      ok: failed.exitCode === 77,
    });

    installer = 'sleep 30\nprintf stale > "$HOME/late-write"';
    const interrupted = new AbortController();
    const timeout = setTimeout(
      () => interrupted.abort(new Error("scenario interruption")),
      100,
    );
    let aborted = false;
    try {
      await installCuaDriver({ env, signal: interrupted.signal });
    } catch {
      aborted = true;
    } finally {
      clearTimeout(timeout);
    }
    const lateWrite = await readFile(join(root, "late-write"), "utf8").catch(
      () => undefined,
    );
    results.push({
      scenario: "cancel owns installer descendants",
      ok: aborted && lateWrite === undefined,
    });

    const executable = join(root, "driver-fixture");
    await writeFile(
      executable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "cua-driver 0.34.0\\n"; else printf \'{"width":100,"height":50,"scale_factor":2}\\n\'; fi\n',
    );
    await chmod(executable, 0o755);
    installer =
      'mkdir -p "$CUA_DRIVER_RS_INSTALL_DIR"\ncp "$HOME/driver-fixture" "$CUA_DRIVER_RS_INSTALL_DIR/cua-driver"\n';
    const retry = await installCuaDriver({ env });
    const binary = resolveCuaDriverCommand(env);
    results.push({
      scenario: "retry and discover outside PATH",
      ok:
        retry.exitCode === 0 &&
        binary === join(root, ".local", "bin", "cua-driver"),
    });
    const blockedFile = join(root, "path-file");
    const blockedDirectory = join(root, "path-directory");
    await mkdir(blockedFile);
    await mkdir(join(blockedDirectory, "cua-driver"), { recursive: true });
    await writeFile(join(blockedFile, "cua-driver"), "non-executable", {
      mode: 0o644,
    });
    const shadowedEnv = {
      ...env,
      PATH: `${blockedFile}:${blockedDirectory}:${env.PATH}`,
    };
    results.push({
      scenario: "PATH files and directories preserve installed fallback",
      ok: resolveCuaDriverCommand(shadowedEnv) === binary,
    });
    results.push({
      scenario: "PATH lookup returns the later executable's absolute path",
      ok:
        resolveCuaDriverCommand({
          ...shadowedEnv,
          PATH: `${shadowedEnv.PATH}:${join(root, ".local", "bin")}`,
        }) === binary,
    });
    const adapter = new CuaDriverTransport({ env: shadowedEnv });
    await adapter.open({ vars: {}, bus: createTransportBus() });
    const size = await adapter.action({
      kind: "cua_get_screen_size",
      params: {},
    });
    results.push({
      scenario: "transport consumes installed provider",
      ok: size.ok && (size.data as { width: number }).width === 100,
    });
    await adapter.close();
  } else {
    results.push({
      scenario: "POSIX installer subprocess and recovery",
      skipped: true,
      reason: `The shell fixture requires macOS or Linux; current host is ${process.platform}`,
    });
  }
  results.push({
    scenario: "explicit executable ownership",
    ok:
      resolveCuaDriverCommand({
        ...env,
        UNICLI_CUA_DRIVER_COMMAND: "/custom/cua-driver",
      }) === "/custom/cua-driver",
  });
  results.push({
    scenario: "shared invalid argv rejection",
    ok: !parseCuaDriverArgs("{broken").ok && !parseCuaDriverArgs("[1]").ok,
  });
  results.push({
    scenario: "Windows official installer URL",
    ok: cuaDriverInstallerUrl("win32") === "https://cua.ai/driver/install.ps1",
  });
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.some((result) => result.ok === false) ? 1 : 0;
