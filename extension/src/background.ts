/**
 * Unicli Browser Bridge — Chrome Extension Service Worker.
 *
 * Connects to the unicli daemon via WebSocket and dispatches
 * commands to Chrome tabs using chrome.debugger API.
 */

import {
  DAEMON_WS_URL,
  DAEMON_PING_URL,
  WS_RECONNECT_BASE_DELAY,
  WS_RECONNECT_MAX_DELAY,
  MAX_EAGER_ATTEMPTS,
  KEEPALIVE_ALARM_PERIOD,
  WINDOW_IDLE_TIMEOUT,
  type Command,
  type Result,
} from "./protocol.js";

// ── State ───────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

interface AutomationSession {
  windowId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleDeadlineAt: number;
  owned: boolean;
  preferredTabId: number | null;
}

const automationSessions = new Map<string, AutomationSession>();

// ── Console log forwarding ──────────────────────────────────────────

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

function forwardLog(level: string, ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "log", level, msg, ts: Date.now() }));
  }
}

console.log = (...args: unknown[]) => { origLog(...args); forwardLog("log", ...args); };
console.warn = (...args: unknown[]) => { origWarn(...args); forwardLog("warn", ...args); };
console.error = (...args: unknown[]) => { origError(...args); forwardLog("error", ...args); };

// ── WebSocket Connection ────────────────────────────────────────────

async function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  // Pre-probe daemon reachability
  try {
    const resp = await fetch(DAEMON_PING_URL, { signal: AbortSignal.timeout(1000) });
    if (!resp.ok) return;
  } catch {
    return; // Daemon not running — skip WS attempt
  }

  try {
    ws = new WebSocket(DAEMON_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[bridge] Connected to daemon");
    reconnectAttempts = 0;
    ws!.send(JSON.stringify({
      type: "hello",
      version: chrome.runtime.getManifest().version,
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const cmd = JSON.parse(event.data as string) as Command;
      const result = await handleCommand(cmd);
      ws?.send(JSON.stringify(result));
    } catch {
      // Malformed message — ignore
    }
  };

  ws.onclose = () => {
    console.log("[bridge] Disconnected from daemon");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (reconnectAttempts >= MAX_EAGER_ATTEMPTS) return; // rely on keepalive alarm

  const delay = Math.min(
    WS_RECONNECT_BASE_DELAY * 2 ** reconnectAttempts,
    WS_RECONNECT_MAX_DELAY,
  );
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ── Automation Window Management ────────────────────────────────────

async function getAutomationWindow(
  workspace: string,
  initialUrl?: string,
): Promise<{ windowId: number; tabId: number }> {
  const existing = automationSessions.get(workspace);
  if (existing) {
    // Reset idle timer
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => closeSession(workspace), WINDOW_IDLE_TIMEOUT);
    existing.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;

    // Get preferred tab
    if (existing.preferredTabId) {
      return { windowId: existing.windowId, tabId: existing.preferredTabId };
    }
    const tabs = await chrome.tabs.query({ windowId: existing.windowId });
    const tabId = tabs[0]?.id ?? -1;
    return { windowId: existing.windowId, tabId };
  }

  // Create new automation window
  const win = await chrome.windows.create({
    width: 1280,
    height: 900,
    type: "normal",
    focused: false,
    url: initialUrl ?? "about:blank",
  });

  const tabId = win.tabs?.[0]?.id ?? -1;

  const session: AutomationSession = {
    windowId: win.id!,
    idleTimer: setTimeout(() => closeSession(workspace), WINDOW_IDLE_TIMEOUT),
    idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
    owned: true,
    preferredTabId: tabId,
  };
  automationSessions.set(workspace, session);

  return { windowId: win.id!, tabId };
}

async function closeSession(workspace: string): Promise<void> {
  const session = automationSessions.get(workspace);
  if (!session) return;
  automationSessions.delete(workspace);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    await chrome.windows.remove(session.windowId);
  } catch { /* already closed */ }
}

// ── Command Dispatcher ──────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = cmd.workspace ?? "default";
  try {
    const { tabId } = await getAutomationWindow(workspace, cmd.url);

    switch (cmd.action) {
      case "exec": {
        const result = await chrome.debugger.sendCommand(
          { tabId },
          "Runtime.evaluate",
          {
            expression: cmd.code,
            returnByValue: true,
            awaitPromise: true,
            allowUnsafeEvalBlockedByCSP: true,
          },
        );
        return { id: cmd.id, ok: true, data: (result as any)?.result?.value };
      }

      case "navigate": {
        await chrome.tabs.update(tabId, { url: cmd.url });
        // Wait for page load
        await new Promise<void>((resolve) => {
          const listener = (
            updatedTabId: number,
            info: chrome.tabs.TabChangeInfo,
          ) => {
            if (updatedTabId === tabId && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 30000);
        });
        return { id: cmd.id, ok: true };
      }

      case "tabs": {
        const session = automationSessions.get(workspace);
        if (!session) return { id: cmd.id, ok: true, data: [] };
        const tabs = await chrome.tabs.query({ windowId: session.windowId });
        return {
          id: cmd.id,
          ok: true,
          data: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        };
      }

      case "cookies": {
        const domain = cmd.domain ?? "";
        const cookies = await chrome.cookies.getAll({ domain });
        const obj: Record<string, string> = {};
        for (const c of cookies) obj[c.name] = c.value;
        return { id: cmd.id, ok: true, data: obj };
      }

      case "screenshot": {
        const result = await chrome.debugger.sendCommand(
          { tabId },
          "Page.captureScreenshot",
          {
            format: cmd.format ?? "png",
            quality: cmd.quality,
            fromSurface: true,
          },
        );
        return { id: cmd.id, ok: true, data: (result as any)?.data };
      }

      case "close-window": {
        await closeSession(workspace);
        return { id: cmd.id, ok: true };
      }

      case "sessions": {
        const sessions = Array.from(automationSessions.entries()).map(
          ([ws, s]) => ({
            workspace: ws,
            windowId: s.windowId,
            idle: Date.now() > s.idleDeadlineAt,
          }),
        );
        return { id: cmd.id, ok: true, data: { sessions } };
      }

      case "set-file-input": {
        // Resolve node and set files
        const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument");
        const node = await chrome.debugger.sendCommand({ tabId }, "DOM.querySelector", {
          nodeId: (doc as any).root.nodeId,
          selector: cmd.selector,
        });
        await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
          nodeId: (node as any).nodeId,
          files: cmd.files,
        });
        return { id: cmd.id, ok: true };
      }

      case "insert-text": {
        await chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
          text: cmd.text,
        });
        return { id: cmd.id, ok: true };
      }

      case "cdp": {
        if (!cmd.cdpMethod) {
          return { id: cmd.id, ok: false, error: "Missing cdpMethod" };
        }
        const result = await chrome.debugger.sendCommand(
          { tabId },
          cmd.cdpMethod,
          cmd.cdpParams ?? {},
        );
        return { id: cmd.id, ok: true, data: result };
      }

      case "bind-current": {
        // Bind the currently focused tab to this workspace
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) {
          return { id: cmd.id, ok: false, error: "No active tab" };
        }
        const session = automationSessions.get(workspace);
        if (session) {
          session.preferredTabId = activeTab.id;
        }
        return { id: cmd.id, ok: true, data: { tabId: activeTab.id, url: activeTab.url } };
      }

      default:
        return { id: cmd.id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return {
      id: cmd.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────

function initialize(): void {
  connect();
  chrome.alarms.create("keepalive", { periodInMinutes: KEEPALIVE_ALARM_PERIOD });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") connect();
});

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
