/**
 * Daemon HTTP client — CLI-side bridge to the browser daemon.
 *
 * All requests go to http://127.0.0.1:<port> with X-Unicli header.
 * Retry logic: max 4 attempts, 500ms for network errors, 1500ms for extension restarts.
 */

import { randomBytes } from "node:crypto";
import {
  DAEMON_PORT,
  DAEMON_HOST,
  type DaemonAction,
  type DaemonCommand,
  type DaemonResult,
  type DaemonStatus,
  type BrowserSessionInfo,
} from "./protocol.js";

const DEFAULT_COMMAND_TIMEOUT = 30_000;
const MAX_RETRIES = 4;
const NETWORK_RETRY_DELAY = 500;
const EXTENSION_RETRY_DELAY = 1500;

function getPort(): number {
  return parseInt(
    process.env.UNICLI_DAEMON_PORT ??
      process.env.OPENCLI_DAEMON_PORT ??
      String(DAEMON_PORT),
    10,
  );
}

function baseUrl(): string {
  return `http://${DAEMON_HOST}:${getPort()}`;
}

function daemonHeader(): Record<string, string> {
  if (!process.env.UNICLI_DAEMON_PORT && process.env.OPENCLI_DAEMON_PORT) {
    return { "X-OpenCLI": "1" };
  }
  return { "X-Unicli": "1" };
}

function generateId(): string {
  return randomBytes(8).toString("hex");
}

function isTransientBrowserError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("extension disconnected") ||
    msg.includes("service worker") ||
    msg.includes("target closed")
  );
}

export async function fetchDaemonStatus(opts?: {
  timeout?: number;
}): Promise<DaemonStatus | null> {
  const timeout = opts?.timeout ?? 2000;
  try {
    const resp = await fetch(`${baseUrl()}/status`, {
      headers: daemonHeader(),
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

export async function requestDaemonShutdown(opts?: {
  timeout?: number;
}): Promise<boolean> {
  const timeout = opts?.timeout ?? 5000;
  try {
    const resp = await fetch(`${baseUrl()}/shutdown`, {
      method: "POST",
      headers: daemonHeader(),
      signal: AbortSignal.timeout(timeout),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function isDaemonRunning(): Promise<boolean> {
  const status = await fetchDaemonStatus({ timeout: 1000 });
  return status !== null;
}

export async function isExtensionConnected(): Promise<boolean> {
  const status = await fetchDaemonStatus({ timeout: 1000 });
  return status?.extensionConnected ?? false;
}

export async function sendCommand(
  action: DaemonAction,
  params: Omit<DaemonCommand, "id" | "action"> = {},
): Promise<unknown> {
  const timeout = (params.timeout ?? DEFAULT_COMMAND_TIMEOUT / 1000) * 1000;
  const focusEnv = process.env.UNICLI_WINDOW_FOCUSED;
  const windowFocused =
    focusEnv === "1" || focusEnv === "true"
      ? true
      : focusEnv === "0" || focusEnv === "false"
        ? false
        : undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const id = generateId(); // Fresh ID per attempt
    try {
      const resp = await fetch(`${baseUrl()}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...daemonHeader(),
        },
        body: JSON.stringify({
          id,
          action,
          ...params,
          ...(windowFocused !== undefined ? { windowFocused } : {}),
        }),
        signal: AbortSignal.timeout(timeout),
      });

      const result = (await resp.json()) as DaemonResult;
      if (!result.ok) {
        const err = new Error(result.error ?? `Command failed: ${action}`);
        if (isTransientBrowserError(err) && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, EXTENSION_RETRY_DELAY));
          continue;
        }
        throw err;
      }
      return result.data ?? result;
    } catch (err) {
      if (err instanceof TypeError && attempt < MAX_RETRIES) {
        // Network error (daemon unreachable)
        await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY));
        continue;
      }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Command timeout: ${action} (${timeout / 1000}s)`);
      }
      throw err;
    }
  }

  throw new Error(`Command failed after ${MAX_RETRIES} retries: ${action}`);
}

export async function listSessions(): Promise<BrowserSessionInfo[]> {
  const result = await sendCommand("sessions");
  return (result as { sessions?: BrowserSessionInfo[] })?.sessions ?? [];
}

export async function bindCurrentTab(
  workspace: string,
  opts?: { matchDomain?: string; matchPathPrefix?: string },
): Promise<unknown> {
  return sendCommand("bind-current", { workspace, ...opts });
}
