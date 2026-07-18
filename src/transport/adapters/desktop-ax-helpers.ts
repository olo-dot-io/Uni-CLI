/**
 * @owner       src::transport::adapters::desktop-ax-helpers
 * @does        Normalize native AX snapshots and manage cached Swift-script binaries for DesktopAxTransport.
 * @needs       filesystem, crypto hashing, desktop AX target resolver, snapshot encoder types.
 * @feeds       desktop AX snapshot encoding, target filtering, and Swift execution.
 * @breaks      Dropping native state booleans or exact window identity makes ref preflight and condition waits disagree with the observed UI.
 * @invariants  Equivalent scripts map to one cache path; normalized descendants inherit app/pid/window/scope and retain actionable states.
 * @side-effects Creates and chmods content-addressed Swift binaries under the Uni-CLI cache.
 * @perf        One tree normalization pass; one cached Swift compilation per unique script digest.
 * @concurrency One in-process compile promise owns each content digest.
 * @test        tests/unit/transport/adapters/desktop-ax.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { createHash } from "node:crypto";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RawAxNode } from "../snapshot-encoder.js";
import type { AxShell } from "./desktop-ax.js";
import {
  resolveAxTarget,
  type AxWindowsScriptOptions,
  type ResolvedAxTarget,
} from "./desktop-ax-swift.js";

export const SWIFT_SCRIPT_CACHE_VERSION = "v1";

const swiftScriptCompileLocks = new Map<string, Promise<void>>();

export async function ensureSwiftScriptBinary(
  script: string,
  shell: AxShell,
): Promise<string> {
  const digest = createHash("sha256")
    .update(SWIFT_SCRIPT_CACHE_VERSION)
    .update("\0")
    .update(script)
    .digest("hex");
  const root = swiftScriptCacheDir();
  const sourcePath = join(root, `${digest}.swift`);
  const binaryPath = join(root, digest);

  if (await fileExists(binaryPath)) return binaryPath;

  let lock = swiftScriptCompileLocks.get(binaryPath);
  if (!lock) {
    lock = compileSwiftScript(shell, sourcePath, binaryPath, script);
    swiftScriptCompileLocks.set(binaryPath, lock);
  }

  try {
    await lock;
  } finally {
    swiftScriptCompileLocks.delete(binaryPath);
  }
  return binaryPath;
}

async function compileSwiftScript(
  shell: AxShell,
  sourcePath: string,
  binaryPath: string,
  script: string,
): Promise<void> {
  await mkdir(swiftScriptCacheDir(), { recursive: true });
  await writeFile(sourcePath, script, "utf8");
  await shell.run("swiftc", [sourcePath, "-O", "-o", binaryPath], {
    timeoutMs: 30_000,
  });
  await chmod(binaryPath, 0o755);
}

export function swiftScriptCacheDir(): string {
  return (
    process.env.UNICLI_AX_SWIFT_CACHE_DIR ??
    join(homedir(), ".unicli", "cache", "swift", SWIFT_SCRIPT_CACHE_VERSION)
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function launchOpenArgs(
  target: ResolvedAxTarget,
  params: Record<string, unknown>,
): string[] {
  const debugPort =
    typeof params.debugPort === "number"
      ? params.debugPort
      : typeof params.debugPort === "string"
        ? Number(params.debugPort)
        : undefined;
  if (typeof debugPort !== "number" || !Number.isFinite(debugPort)) {
    return [...target.openArgs];
  }
  return [
    "-a",
    target.appName,
    "--args",
    `--remote-debugging-port=${debugPort}`,
  ];
}

export function readAxWindowsFilter(
  params: Record<string, unknown>,
): AxWindowsScriptOptions {
  const resolved = resolveAxTarget(params);
  if (resolved) {
    return {
      appName: resolved.appName,
      bundleId: resolved.bundleId,
      processName: resolved.processName,
    };
  }
  return {
    appName: readStringParam(params.app),
    bundleId: readStringParam(params.bundleId),
    processName: readStringParam(params.processName),
  };
}

export function normalizeAxSnapshot(
  input: Record<string, unknown>,
  path = String(input.role ?? "AXUnknown") + "[0]",
  scope = readScope(input),
  inherited: { app?: string; pid?: number; windowId?: number } = {},
): RawAxNode {
  const role = typeof input.role === "string" ? input.role : "AXUnknown";
  const app = typeof input.app === "string" ? input.app : inherited.app;
  const pid = typeof input.pid === "number" ? input.pid : inherited.pid;
  const windowId =
    typeof input.windowId === "number" &&
    Number.isSafeInteger(input.windowId) &&
    input.windowId > 0
      ? input.windowId
      : inherited.windowId;
  const children = Array.isArray(input.children)
    ? normalizeChildren(input.children, path, scope, { app, pid, windowId })
    : undefined;
  return {
    role,
    name: readName(input),
    value: typeof input.value === "string" ? input.value : undefined,
    bounds: readBounds(input),
    screenIndex: readScreenIndex(input),
    states: readStates(input),
    children,
    path,
    scope,
    app,
    pid,
    windowId,
  };
}

function normalizeChildren(
  children: unknown[],
  parentPath: string,
  scope: string,
  inherited: { app?: string; pid?: number; windowId?: number },
): RawAxNode[] {
  const roleCounts = new Map<string, number>();
  const nodes: RawAxNode[] = [];

  for (const child of children) {
    if (!isRecord(child)) continue;
    const role = typeof child.role === "string" ? child.role : "AXUnknown";
    const index = roleCounts.get(role) ?? 0;
    roleCounts.set(role, index + 1);
    nodes.push(
      normalizeAxSnapshot(
        child,
        `${parentPath}/${role}[${index}]`,
        scope,
        inherited,
      ),
    );
  }
  return nodes;
}

function readScope(input: Record<string, unknown>): string {
  if (typeof input.scope === "string" && input.scope) return input.scope;
  if (typeof input.pid === "number") return String(input.pid);
  return "focusedWindow";
}

function readName(input: Record<string, unknown>): string | undefined {
  for (const key of ["name", "title", "label", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function readBounds(
  input: Record<string, unknown>,
): RawAxNode["bounds"] | undefined {
  const bounds = input.bounds;
  if (!isRecord(bounds)) return undefined;
  const x = readNumber(bounds.x);
  const y = readNumber(bounds.y);
  const w = readNumber(bounds.w ?? bounds.width);
  const h = readNumber(bounds.h ?? bounds.height);
  if (
    x === undefined ||
    y === undefined ||
    w === undefined ||
    h === undefined
  ) {
    return undefined;
  }
  return { x, y, w, h };
}

function readScreenIndex(input: Record<string, unknown>): number | undefined {
  const value = input.screenIndex;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function readStates(
  input: Record<string, unknown>,
): readonly string[] | undefined {
  const states = new Set(
    Array.isArray(input.states)
      ? input.states.filter(
          (state): state is string => typeof state === "string",
        )
      : [],
  );
  if (input.enabled === true) states.add("enabled");
  if (input.enabled === false) states.add("disabled");
  if (input.focused === true) states.add("focused");
  if (input.checked === true) states.add("checked");
  if (input.minimized === true) states.add("minimized");
  return states.size > 0 ? Array.from(states) : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function readStringParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escape an AppleScript string literal used inside `osascript -e`. */
export function escapeAs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ")
    .replaceAll("\0", "");
}
