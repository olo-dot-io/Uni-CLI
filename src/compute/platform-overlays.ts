/**
 * @owner   src/compute/platform-overlays.ts
 * @does    Select the native compute overlay HUD provider for the host platform.
 * @needs   macOS AppKit, Windows Win32, Linux GTK overlay providers
 * @feeds   compute CLI, computer-use MCP profile, doctor compute
 * @breaks  Platform-specific provider branching in callers causes divergent overlay behavior.
 * @invariants Supported desktop platforms map to exactly one native system HUD provider.
 * @side-effects none at selection time
 * @perf    O(1)
 * @concurrency pure factory
 * @test    tests/unit/compute-platform-overlays.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import { LinuxGtkOverlayDaemonProvider } from "./linux-overlay.js";
import { MacosAppKitOverlayDaemonProvider } from "./macos-overlay.js";
import type { ComputeOverlayProvider } from "./overlay.js";
import { WindowsWin32OverlayDaemonProvider } from "./windows-overlay.js";

export interface PlatformComputeOverlayProviderOptions {
  platform?: NodeJS.Platform;
}

export function createPlatformComputeOverlayProvider(
  opts: PlatformComputeOverlayProviderOptions = {},
): ComputeOverlayProvider | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    return new MacosAppKitOverlayDaemonProvider({ platform });
  }
  if (platform === "win32") {
    return new WindowsWin32OverlayDaemonProvider({ platform });
  }
  if (platform === "linux") {
    return new LinuxGtkOverlayDaemonProvider({ platform });
  }
  return undefined;
}
