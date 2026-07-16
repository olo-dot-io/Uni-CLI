/**
 * @owner       extension/src/background.ts
 * @does        Reconcile durable target ownership, maintain one Chrome Native Messaging port, dispatch broker commands, and reconnect after host/service-worker interruption.
 * @needs       chrome.runtime, chrome.alarms, chrome.tabs, extension/src/chrome-controller.ts, target-ledger.ts, src/browser/chrome-native-protocol.ts
 * @feeds       Uni-CLI Chrome native host
 * @breaks      Logs connection/dispatch/deadline failures; broker status remains disconnected until an identity-compatible native host is available.
 * @invariants  No loopback discovery, WebSocket, port scan, or browser-window creation occurs at connection time; hello includes only live ledger-reconciled targets; every in-generation completed command receives one correlated result; a command deadline cancels local ownership work and abandons the entire native-port generation; any stale completion forces a later ledger reconciliation before another stable generation.
 * @side-effects Opens a Chrome Native Messaging port, posts hello/results, installs lifecycle listeners and a keepalive alarm.
 * @perf        Idle work is one native port plus a 24-second reconnect alarm; commands are sequential from the native host.
 * @concurrency A connection generation prevents stale disconnect callbacks from clearing a replacement port.
 * @test        tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import {
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_COMMAND_DEADLINE_MS,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  type ChromeNativeCommand,
} from "../../src/browser/chrome-native-protocol.js";
import { getChromeBrowserSessionId } from "./browser-session.js";
import { reconcileBackgroundTargetSupervision } from "./background-supervisor.js";
import { handleChromeNativeCommand } from "./chrome-controller.js";
import { registerNetworkCaptureListeners } from "./network-capture.js";
import { forgetChromeTab, reconcileChromeTargets } from "./target-ledger.js";

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const KEEPALIVE_ALARM_PERIOD_MINUTES = 0.4;

let nativePort: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connectionGeneration = 0;
let connectionAttempt: Promise<void> | null = null;
let reconciliationRevision = 0;

function connectNativeHost(): void {
  if (nativePort || connectionAttempt) return;
  connectionAttempt = openNativeHost()
    .catch((error: unknown) => {
      console.error(
        `[unicli] Native host initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      scheduleReconnect();
    })
    .finally(() => {
      connectionAttempt = null;
    });
}

async function openNativeHost(): Promise<void> {
  const observedReconciliationRevision = reconciliationRevision;
  const browserSessionId = await getChromeBrowserSessionId();
  const reconciledTargets = await reconcileChromeTargets();
  const targets = await reconcileBackgroundTargetSupervision(reconciledTargets);
  if (nativePort) return;
  const generation = ++connectionGeneration;
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(CHROME_NATIVE_HOST_NAME);
  } catch (error) {
    console.error(
      `[unicli] Native host connection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    scheduleReconnect();
    return;
  }
  nativePort = port;
  reconnectAttempts = 0;
  port.onMessage.addListener((message: unknown) => {
    void dispatchNativeCommand(port, generation, message);
  });
  port.onDisconnect.addListener(() => {
    const lastError = chrome.runtime.lastError?.message;
    if (lastError)
      console.error(`[unicli] Native host disconnected: ${lastError}`);
    if (connectionGeneration !== generation) return;
    nativePort = null;
    scheduleReconnect();
  });
  port.postMessage({
    type: "hello",
    product: CHROME_NATIVE_PRODUCT,
    protocol: CHROME_NATIVE_PROTOCOL,
    version: CHROME_NATIVE_PROTOCOL_VERSION,
    extension_id: chrome.runtime.id,
    extension_version: chrome.runtime.getManifest().version,
    browser_session_id: browserSessionId,
    targets,
  });
  if (reconciliationRevision > observedReconciliationRevision) {
    retireNativeConnection(
      port,
      generation,
      "A stale command completed while the replacement hello was being reconciled",
    );
  }
}

async function dispatchNativeCommand(
  port: chrome.runtime.Port,
  generation: number,
  message: unknown,
): Promise<void> {
  if (connectionGeneration !== generation || nativePort !== port) return;
  const command = message as ChromeNativeCommand;
  const controller = new AbortController();
  const execution = handleChromeNativeCommand(command, controller.signal);
  void execution
    .finally(() => {
      if (connectionGeneration !== generation || nativePort !== port) {
        requestTargetReconciliation();
      }
    })
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Chrome command ${command.request_id} exceeded its ${String(CHROME_NATIVE_COMMAND_DEADLINE_MS)}ms execution deadline`,
        );
        controller.abort(error);
        reject(error);
      }, CHROME_NATIVE_COMMAND_DEADLINE_MS);
    });
    const result = await Promise.race([execution, deadline]);
    if (connectionGeneration === generation && nativePort === port) {
      port.postMessage(result);
    }
  } catch (error) {
    abandonNativeConnection(port, generation, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abandonNativeConnection(
  port: chrome.runtime.Port,
  generation: number,
  error: unknown,
): void {
  if (connectionGeneration !== generation || nativePort !== port) return;
  console.error(
    `[unicli] Native command generation abandoned: ${error instanceof Error ? error.message : String(error)}`,
  );
  retireNativeConnection(port, generation, "command generation abandoned");
}

function requestTargetReconciliation(): void {
  reconciliationRevision += 1;
  const port = nativePort;
  if (!port) {
    scheduleReconnect();
    return;
  }
  retireNativeConnection(
    port,
    connectionGeneration,
    "stale command completion requires target-ledger reconciliation",
  );
}

function retireNativeConnection(
  port: chrome.runtime.Port,
  generation: number,
  reason: string,
): void {
  if (connectionGeneration !== generation || nativePort !== port) return;
  console.error(`[unicli] Native connection retired: ${reason}`);
  connectionGeneration += 1;
  nativePort = null;
  port.disconnect();
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts,
    RECONNECT_MAX_DELAY_MS,
  );
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, delay);
}

function initialize(): void {
  registerNetworkCaptureListeners();
  chrome.alarms.create("unicli-native-host-keepalive", {
    periodInMinutes: KEEPALIVE_ALARM_PERIOD_MINUTES,
  });
  connectNativeHost();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "unicli-native-host-keepalive") connectNativeHost();
});
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
chrome.tabs.onRemoved.addListener((tabId) => {
  void forgetChromeTab(tabId).catch((error: unknown) => {
    console.error(
      `[unicli] Target-ledger tab removal failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
});

initialize();
