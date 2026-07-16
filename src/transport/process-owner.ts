/**
 * @owner       src::transport::process-owner
 * @does        Spawn commands inside a verifiable POSIX process group or Windows kill-on-close Job Object and terminate that saved ownership identity independently of leader liveness.
 * @needs       node child_process/fs/module/os/path, optional unicli-process-owner Windows package
 * @feeds       contained commands, native sidecars, browser broker launch, managed Chromium, and explicit CDP application launch
 * @breaks      Direct Windows spawn has no race-free descendant containment; signalling only a POSIX leader allows same-group descendants to mutate after settlement; a POSIX group that remains observable after both termination budgets fails containment even when kill(2) reported partial permission.
 * @invariants  POSIX commands are group leaders and containment succeeds only after the saved group is no longer observable; macOS partial-group EPERM is verified by the same bounded postcondition instead of being treated as success or immediate failure; Windows commands are children of a wrapper that joins a kill-on-close Job before spawning; an unowned Windows child is never reported contained; report identity must match the wrapper PID; every exposed ownership promise is internally observed even when a caller needs only the child stream.
 * @side-effects Spawns processes, reads/removes optional owner reports, signals process groups, and terminates Job-owning wrappers.
 * @perf        Healthy spawn adds no process on POSIX and one small waiting wrapper on Windows; termination polling is bounded.
 * @concurrency Ownership metadata is child-object scoped; report listeners and timers are removed exactly once.
 * @test        tests/unit/transport/process-owner.test.ts and tests/unit/transport/contained-process.test.ts
 * @stability   stable
 * @since       2026-07-16
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform as hostPlatform } from "node:os";
import { win32 } from "node:path";

export type ProcessOwnerIdentity =
  | { kind: "posix-process-group"; owner_pid: number; process_group_id: number }
  | { kind: "windows-job"; owner_pid: number };

export interface SpawnOwnedProcessOptions extends Omit<
  SpawnOptions,
  "detached" | "signal"
> {
  reportPath?: string;
  reportTimeoutMs?: number;
}

export interface OwnedProcessLaunch<Child extends ChildProcess = ChildProcess> {
  child: Child;
  identity: Promise<ProcessOwnerIdentity>;
  commandPid?: Promise<number>;
}

export interface ResolveProcessOwnerOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  requireResolve?: (id: string) => string;
  homeDir?: string;
}

interface WindowsOwnerReport {
  version: 1;
  containment: "windows-job";
  owner_pid: number;
  command_pid: number;
}

const require = createRequire(import.meta.url);
const ownership = new WeakMap<ChildProcess, Promise<ProcessOwnerIdentity>>();
const PROCESS_TERM_GRACE_MS = 200;
const PROCESS_KILL_GRACE_MS = 2_000;
const PROCESS_POLL_MS = 10;
const DEFAULT_REPORT_TIMEOUT_MS = 5_000;

export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOwnedProcessOptions & {
    stdio: ["pipe", "pipe", "pipe"];
  },
): OwnedProcessLaunch<ChildProcessWithoutNullStreams>;
export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options?: SpawnOwnedProcessOptions,
): OwnedProcessLaunch;
export function spawnOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOwnedProcessOptions = {},
): OwnedProcessLaunch {
  const platform = hostPlatform();
  const { reportPath, reportTimeoutMs, ...spawnOptions } = options;
  if (platform === "win32") {
    const ownerCommand = resolveProcessOwnerBinary();
    if (reportPath) rmSync(reportPath, { force: true });
    const child = spawn(
      ownerCommand,
      [...(reportPath ? ["--report", reportPath] : []), "--", command, ...args],
      {
        ...spawnOptions,
        detached: false,
        windowsHide: true,
      },
    );
    const identity = processIdentity(child, (ownerPid) => ({
      kind: "windows-job",
      owner_pid: ownerPid,
    }));
    ownership.set(child, identity);
    const commandPid = reportPath
      ? identity.then(() =>
          awaitWindowsOwnerReport(
            child,
            reportPath,
            reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS,
          ),
        )
      : undefined;
    observeRejection(commandPid);
    return {
      child,
      identity,
      ...(commandPid ? { commandPid } : {}),
    };
  }

  const child = spawn(command, [...args], {
    ...spawnOptions,
    detached: true,
  });
  const identity = processIdentity(child, (pid) => ({
    kind: "posix-process-group",
    owner_pid: pid,
    process_group_id: pid,
  }));
  ownership.set(child, identity);
  const commandPid = identity.then((value) => value.owner_pid);
  observeRejection(commandPid);
  return {
    child,
    identity,
    commandPid,
  };
}

export function processOwnerIdentity(
  child: ChildProcess,
): Promise<ProcessOwnerIdentity> | undefined {
  return ownership.get(child);
}

export async function terminateOwnedProcess(
  child: ChildProcess,
): Promise<void> {
  const identityPromise = ownership.get(child);
  if (!identityPromise) {
    throw new Error("process was not spawned by the Uni-CLI process owner");
  }
  await terminateProcessOwner(await identityPromise);
}

export async function terminateProcessOwner(
  identity: ProcessOwnerIdentity,
): Promise<void> {
  if (identity.kind === "windows-job") {
    await terminateWindowsJobOwner(identity.owner_pid);
    return;
  }
  const termError = signalPosixProcessGroup(
    identity.process_group_id,
    "SIGTERM",
  );
  if (
    await waitForPosixProcessGroupExit(
      identity.process_group_id,
      PROCESS_TERM_GRACE_MS,
    )
  ) {
    return;
  }
  const killError = signalPosixProcessGroup(
    identity.process_group_id,
    "SIGKILL",
  );
  if (
    await waitForPosixProcessGroupExit(
      identity.process_group_id,
      PROCESS_KILL_GRACE_MS,
    )
  ) {
    return;
  }
  const signalErrors = [termError, killError].filter(
    (error): error is NodeJS.ErrnoException => error !== undefined,
  );
  throw new Error(
    `native process group ${String(identity.process_group_id)} did not exit after SIGKILL`,
    signalErrors.length > 0
      ? {
          cause: new AggregateError(
            signalErrors,
            "POSIX process-group signals reported partial permission",
          ),
        }
      : undefined,
  );
}

export function processOwnerExists(identity: ProcessOwnerIdentity): boolean {
  return identity.kind === "windows-job"
    ? processExists(identity.owner_pid)
    : posixProcessGroupExists(identity.process_group_id);
}

export function resolveProcessOwnerBinary(
  options: ResolveProcessOwnerOptions = {},
): string {
  const platform = options.platform ?? hostPlatform();
  if (platform !== "win32") {
    throw new Error("the native process-owner wrapper is Windows-only");
  }
  const env = options.env ?? process.env;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const requireResolve = options.requireResolve ?? require.resolve;
  const override = env.UNICLI_PROCESS_OWNER;
  if (override) return override;

  const packageName =
    arch === "x64" || arch === "arm64"
      ? `@zenalexa/unicli-process-owner-win32-${arch}`
      : undefined;
  if (packageName) {
    try {
      const packageJson = requireResolve(`${packageName}/package.json`);
      return win32.join(win32.dirname(packageJson), "unicli-process-owner.exe");
    } catch {
      // REASON: optional platform packages are absent on other architectures; resolution continues to the explicit user install and PATH locations.
    }
  }
  const userCommand = win32.join(
    options.homeDir ?? homedir(),
    ".unicli",
    "sidecars",
    "unicli-process-owner.exe",
  );
  if (exists(userCommand)) return userCommand;
  return "unicli-process-owner.exe";
}

function awaitWindowsOwnerReport(
  child: ChildProcess,
  reportPath: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: unknown, commandPid?: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(commandPid!);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(
        new Error(
          `process-owner exited before reporting its child (${code === null ? String(signal) : `code ${String(code)}`})`,
        ),
      );
    const poll = (): void => {
      try {
        if (existsSync(reportPath)) {
          const report = parseWindowsOwnerReport(
            readFileSync(reportPath, "utf8"),
            child.pid,
          );
          rmSync(reportPath, { force: true });
          finish(undefined, report.command_pid);
          return;
        }
      } catch (error) {
        finish(error);
        return;
      }
      if (Date.now() >= deadline) {
        finish(
          new Error(
            `process-owner did not report its child within ${String(timeoutMs)}ms`,
          ),
        );
        return;
      }
      timer = setTimeout(poll, PROCESS_POLL_MS);
    };
    child.once("error", onError);
    child.once("exit", onExit);
    poll();
  });
}

function parseWindowsOwnerReport(
  source: string,
  expectedOwnerPid: number | undefined,
): WindowsOwnerReport {
  const value = JSON.parse(source) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("containment" in value) ||
    value.containment !== "windows-job" ||
    !("owner_pid" in value) ||
    !Number.isSafeInteger(value.owner_pid) ||
    value.owner_pid !== expectedOwnerPid ||
    !("command_pid" in value) ||
    !Number.isSafeInteger(value.command_pid) ||
    (value.command_pid as number) <= 0
  ) {
    throw new Error(
      "process-owner report has an invalid or mismatched identity",
    );
  }
  return value as unknown as WindowsOwnerReport;
}

async function terminateWindowsJobOwner(ownerPid: number): Promise<void> {
  if (!processExists(ownerPid)) return;
  try {
    process.kill(ownerPid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + PROCESS_KILL_GRACE_MS;
  while (processExists(ownerPid)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Windows Job owner ${String(ownerPid)} remained live after taskkill`,
      );
    }
    await delay(PROCESS_POLL_MS);
  }
}

function signalPosixProcessGroup(
  processGroup: number,
  signal: NodeJS.Signals,
): NodeJS.ErrnoException | undefined {
  try {
    process.kill(-processGroup, signal);
    return undefined;
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException;
    if (systemError.code === "ESRCH") return undefined;
    if (systemError.code === "EPERM") return systemError;
    throw error;
  }
}

async function waitForPosixProcessGroupExit(
  processGroup: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (posixProcessGroupExists(processGroup)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function posixProcessGroupExists(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function processIdentity(
  child: ChildProcess,
  create: (pid: number) => ProcessOwnerIdentity,
): Promise<ProcessOwnerIdentity> {
  const identity =
    child.pid !== undefined
      ? Promise.resolve(create(child.pid))
      : new Promise<ProcessOwnerIdentity>((resolve, reject) => {
          const onSpawn = (): void => {
            cleanup();
            if (child.pid === undefined) {
              reject(new Error("owned process spawned without a process id"));
              return;
            }
            resolve(create(child.pid));
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(error);
          };
          const cleanup = (): void => {
            child.off("spawn", onSpawn);
            child.off("error", onError);
          };
          child.once("spawn", onSpawn);
          child.once("error", onError);
        });
  void identity.catch(() => undefined);
  return identity;
}

function observeRejection(promise: Promise<unknown> | undefined): void {
  void promise?.catch(() => undefined);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
