/**
 * Daemon ↔ Extension communication protocol.
 * Shared constants and types for the browser daemon system.
 */

// ── Constants ───────────────────────────────────────────────────────

export const DAEMON_PORT = 19825;
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_IDLE_TIMEOUT = 4 * 60 * 60 * 1000; // 4 hours default
export const DAEMON_WS_PATH = "/ext";
export const DAEMON_COMMAND_TIMEOUT = 120_000; // 2 min per command
export const DAEMON_MAX_BODY = 1024 * 1024; // 1 MB body limit
export const WINDOW_IDLE_TIMEOUT = 30_000; // 30s window idle
export const WS_RECONNECT_BASE_DELAY = 2000;
export const WS_RECONNECT_MAX_DELAY = 5000;
export const MAX_EAGER_RECONNECT_ATTEMPTS = 6;
export const HEARTBEAT_INTERVAL = 15_000; // 15s ping interval
export const MAX_MISSED_PONGS = 2;

// ── Types ───────────────────────────────────────────────────────────

export type DaemonAction =
  | "exec"
  | "navigate"
  | "tabs"
  | "cookies"
  | "screenshot"
  | "close-window"
  | "sessions"
  | "set-file-input"
  | "insert-text"
  | "bind-current"
  | "network-capture-start"
  | "network-capture-read"
  | "cdp";

export interface DaemonCommand {
  id: string;
  action: DaemonAction;
  tabId?: number;
  code?: string;
  workspace?: string;
  url?: string;
  domain?: string;
  matchDomain?: string;
  matchPathPrefix?: string;
  pattern?: string;
  cdpMethod?: string;
  cdpParams?: Record<string, unknown>;
  cdpSessionId?: string;
  selector?: string;
  text?: string;
  files?: string[];
  format?: string;
  quality?: number;
  fullPage?: boolean;
  timeout?: number;
}

export interface DaemonResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface DaemonStatus {
  ok: boolean;
  pid: number;
  uptime: number;
  extensionConnected: boolean;
  extensionVersion?: string;
  pending: number;
  lastCliRequestTime: number;
  memoryMB: number;
  port: number;
}

export interface BrowserSessionInfo {
  workspace: string;
  windowId: number;
  tabCount: number;
  idle: boolean;
}

/** Extension→daemon hello message */
export interface ExtensionHello {
  type: "hello";
  version: string;
}

/** Extension→daemon log message */
export interface ExtensionLog {
  type: "log";
  level: "log" | "warn" | "error";
  msg: string;
  ts: number;
}
