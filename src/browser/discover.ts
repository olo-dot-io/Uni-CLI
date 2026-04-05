/**
 * Daemon status discovery — checks if daemon is running
 * and whether the Chrome Extension is connected.
 */

import { fetchDaemonStatus } from "./daemon-client.js";

export { isDaemonRunning } from "./daemon-client.js";

export async function checkDaemonStatus(opts?: { timeout?: number }): Promise<{
  running: boolean;
  extensionConnected: boolean;
  extensionVersion?: string;
}> {
  const status = await fetchDaemonStatus(opts);
  if (!status) {
    return { running: false, extensionConnected: false };
  }
  return {
    running: true,
    extensionConnected: status.extensionConnected,
    extensionVersion: status.extensionVersion,
  };
}
