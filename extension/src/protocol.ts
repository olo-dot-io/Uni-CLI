/**
 * Shared protocol types for daemon ↔ extension communication.
 * Mirrors src/browser/protocol.ts constants.
 */

export const DAEMON_PORT = 19825;
export const DAEMON_HOST = "localhost";
export const DAEMON_WS_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}/ext`;
export const DAEMON_PING_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/ping`;
export const WS_RECONNECT_BASE_DELAY = 2000;
export const WS_RECONNECT_MAX_DELAY = 5000;
export const MAX_EAGER_ATTEMPTS = 6;
export const KEEPALIVE_ALARM_PERIOD = 0.4; // ~24 seconds in minutes
export const WINDOW_IDLE_TIMEOUT = 30_000;

export type Action =
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

export interface Command {
  id: string;
  action: Action;
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
  selector?: string;
  text?: string;
  files?: string[];
  format?: string;
  quality?: number;
  fullPage?: boolean;
  timeout?: number;
}

export interface Result {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
