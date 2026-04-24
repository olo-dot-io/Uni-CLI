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
import {
  readNetworkCapture,
  registerNetworkCaptureListeners,
  startNetworkCapture,
} from "./network-capture.js";

// ── State ───────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function websocketOpenState(): number {
  return typeof WebSocket.OPEN === "number" ? WebSocket.OPEN : 1;
}

function websocketConnectingState(): number {
  return typeof WebSocket.CONNECTING === "number" ? WebSocket.CONNECTING : 0;
}

function createWebSocket(url: string): WebSocket {
  try {
    return new WebSocket(url);
  } catch (err) {
    try {
      return (WebSocket as unknown as (target: string) => WebSocket)(url);
    } catch {
      throw err;
    }
  }
}

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
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  if (ws?.readyState === websocketOpenState()) {
    ws.send(JSON.stringify({ type: "log", level, msg, ts: Date.now() }));
  }
}

console.log = (...args: unknown[]) => {
  origLog(...args);
  forwardLog("log", ...args);
};
console.warn = (...args: unknown[]) => {
  origWarn(...args);
  forwardLog("warn", ...args);
};
console.error = (...args: unknown[]) => {
  origError(...args);
  forwardLog("error", ...args);
};

// ── WebSocket Connection ────────────────────────────────────────────

async function connect(): Promise<void> {
  if (
    ws?.readyState === websocketOpenState() ||
    ws?.readyState === websocketConnectingState()
  )
    return;

  // Pre-probe daemon reachability
  try {
    const resp = await fetch(DAEMON_PING_URL, {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return;
  } catch {
    return; // Daemon not running — skip WS attempt
  }

  try {
    ws = createWebSocket(DAEMON_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[bridge] Connected to daemon");
    reconnectAttempts = 0;
    ws!.send(
      JSON.stringify({
        type: "hello",
        version: chrome.runtime.getManifest().version,
      }),
    );
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
  windowFocused = false,
): Promise<{ windowId: number; tabId: number }> {
  const existing = automationSessions.get(workspace);
  if (existing) {
    // Reset idle timer
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(
      () => closeSession(workspace),
      WINDOW_IDLE_TIMEOUT,
    );
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
    focused: windowFocused,
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
  if (!session.owned) return;
  try {
    await chrome.windows.remove(session.windowId);
  } catch {
    /* already closed */
  }
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const expected = domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (!expected) return true;
  return host === expected || host.endsWith(`.${expected}`);
}

function matchesBindCriteria(tab: chrome.tabs.Tab, cmd: Command): boolean {
  if (!tab.id || !tab.url) return false;
  if (!/^https?:/i.test(tab.url)) return false;
  if (!cmd.matchDomain && !cmd.matchPathPrefix) return true;

  try {
    const url = new URL(tab.url);
    if (cmd.matchDomain && !hostMatchesDomain(url.hostname, cmd.matchDomain)) {
      return false;
    }
    if (cmd.matchPathPrefix && !url.pathname.startsWith(cmd.matchPathPrefix)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Command Dispatcher ──────────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<Result> {
  const workspace = cmd.workspace ?? "default";
  try {
    switch (cmd.action) {
      case "exec": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
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
        const { tabId } = await getAutomationWindow(
          workspace,
          cmd.url,
          cmd.windowFocused === true,
        );
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
        await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
        const domain = cmd.domain ?? "";
        const cookies = await chrome.cookies.getAll({ domain });
        const obj: Record<string, string> = {};
        for (const c of cookies) obj[c.name] = c.value;
        return { id: cmd.id, ok: true, data: obj };
      }

      case "screenshot": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
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
        const now = Date.now();
        const sessions = await Promise.all(
          Array.from(automationSessions.entries()).map(async ([ws, s]) => {
            const tabs = await chrome.tabs.query({ windowId: s.windowId });
            return {
              workspace: ws,
              windowId: s.windowId,
              tabCount: tabs.length,
              owned: s.owned,
              preferredTabId: s.preferredTabId,
              idleMsRemaining: Math.max(0, s.idleDeadlineAt - now),
            };
          }),
        );
        return { id: cmd.id, ok: true, data: { sessions } };
      }

      case "set-file-input": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
        // Resolve node and set files
        const doc = await chrome.debugger.sendCommand(
          { tabId },
          "DOM.getDocument",
        );
        const node = await chrome.debugger.sendCommand(
          { tabId },
          "DOM.querySelector",
          {
            nodeId: (doc as any).root.nodeId,
            selector: cmd.selector,
          },
        );
        await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
          nodeId: (node as any).nodeId,
          files: cmd.files,
        });
        return { id: cmd.id, ok: true };
      }

      case "insert-text": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
        await chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
          text: cmd.text,
        });
        return { id: cmd.id, ok: true };
      }

      case "cdp": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
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
        const activeTabs = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        const fallbackTabs = await chrome.tabs.query({
          lastFocusedWindow: true,
        });
        const allTabs = await chrome.tabs.query({});
        const activeTab =
          activeTabs.find((tab) => matchesBindCriteria(tab, cmd)) ??
          fallbackTabs.find((tab) => matchesBindCriteria(tab, cmd)) ??
          allTabs.find((tab) => matchesBindCriteria(tab, cmd));
        if (!activeTab?.id) {
          return {
            id: cmd.id,
            ok: false,
            error:
              cmd.matchDomain || cmd.matchPathPrefix
                ? `No visible tab matched ${cmd.matchDomain ?? "domain"}${cmd.matchPathPrefix ? ` ${cmd.matchPathPrefix}` : ""}`
                : "No active debuggable tab",
          };
        }
        const session = automationSessions.get(workspace);
        if (session) {
          session.preferredTabId = activeTab.id;
          session.windowId = activeTab.windowId;
          session.owned = false;
          session.idleDeadlineAt = Date.now() + WINDOW_IDLE_TIMEOUT;
        } else {
          automationSessions.set(workspace, {
            windowId: activeTab.windowId,
            idleTimer: setTimeout(
              () => closeSession(workspace),
              WINDOW_IDLE_TIMEOUT,
            ),
            idleDeadlineAt: Date.now() + WINDOW_IDLE_TIMEOUT,
            owned: false,
            preferredTabId: activeTab.id,
          });
        }
        return {
          id: cmd.id,
          ok: true,
          data: {
            tabId: activeTab.id,
            url: activeTab.url,
            title: activeTab.title,
            workspace,
          },
        };
      }

      case "network-capture-start": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
        await startNetworkCapture(tabId, cmd.pattern);
        return { id: cmd.id, ok: true, data: { started: true } };
      }

      case "network-capture-read": {
        const { tabId } = await getAutomationWindow(
          workspace,
          undefined,
          cmd.windowFocused === true,
        );
        return { id: cmd.id, ok: true, data: readNetworkCapture(tabId) };
      }

      default:
        return {
          id: cmd.id,
          ok: false,
          error: `Unknown action: ${cmd.action}`,
        };
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
  registerNetworkCaptureListeners();
  connect();
  chrome.alarms.create("keepalive", {
    periodInMinutes: KEEPALIVE_ALARM_PERIOD,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") connect();
});

chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
