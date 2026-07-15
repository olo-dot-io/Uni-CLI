/**
 * @owner       extension/src/background.ts
 * @does        Maintain one Chrome Native Messaging port, identify the extension, dispatch broker commands, and reconnect after host/service-worker interruption.
 * @needs       chrome.runtime, chrome.alarms, extension/src/chrome-controller.ts, src/browser/chrome-native-protocol.ts
 * @feeds       Uni-CLI Chrome native host
 * @breaks      Logs connection/dispatch failures; broker status remains disconnected until an identity-compatible native host is available.
 * @invariants  No loopback discovery, WebSocket, port scan, or browser-window creation occurs at connection time; every command receives one correlated result.
 * @side-effects Opens a Chrome Native Messaging port, posts hello/results, installs lifecycle listeners and a keepalive alarm.
 * @perf        Idle work is one native port plus a 24-second reconnect alarm; commands are sequential from the native host.
 * @concurrency A connection generation prevents stale disconnect callbacks from clearing a replacement port.
 * @test        tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import {
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  type ChromeNativeCommand,
} from "../../src/browser/chrome-native-protocol.js";
import { getChromeBrowserSessionId } from "./browser-session.js";
import { handleChromeNativeCommand } from "./chrome-controller.js";
import { registerNetworkCaptureListeners } from "./network-capture.js";

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const KEEPALIVE_ALARM_PERIOD_MINUTES = 0.4;

let nativePort: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connectionGeneration = 0;
let connectionAttempt: Promise<void> | null = null;

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
  const browserSessionId = await getChromeBrowserSessionId();
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
  });
}

async function dispatchNativeCommand(
  port: chrome.runtime.Port,
  generation: number,
  message: unknown,
): Promise<void> {
  if (connectionGeneration !== generation || nativePort !== port) return;
  const command = message as ChromeNativeCommand;
  const result = await handleChromeNativeCommand(command);
  if (connectionGeneration === generation && nativePort === port) {
    port.postMessage(result);
  }
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

initialize();
