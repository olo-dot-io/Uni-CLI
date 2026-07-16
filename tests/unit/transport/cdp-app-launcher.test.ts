import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CdpBrowserTransport } from "../../../src/transport/adapters/cdp-browser.js";
import { launchCdpApp } from "../../../src/transport/cdp-app-launcher.js";
import { createTransportBus } from "../../../src/transport/bus.js";

describe("CDP app launcher containment", () => {
  it("contains the launched app tree when attach is cancelled before CDP readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "unicli-cdp-app-launch-"));
    const marker = join(root, "late-descendant.txt");
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 500)`;
    const appScript = [
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore", windowsHide: true }).unref()`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const controller = new AbortController();
    // REASON: CDP readiness is the external boundary; the real adapter, launcher receipt, process owner, cancellation settlement, and descendant process all remain under test.
    const cdpProbe = vi.fn().mockResolvedValue(null);
    const transport = new CdpBrowserTransport({
      cdpProbe,
      appLauncher: (request) =>
        launchCdpApp(
          {
            ...request,
            processName: process.execPath,
            executableNames: [process.execPath],
            extraArgs: ["-e", appScript],
          },
          process.platform === "win32" ? "win32" : "linux",
        ),
    });

    try {
      await transport.open({ vars: {}, bus: createTransportBus() });
      const attachment = transport.action({
        kind: "cdp_attach",
        params: { app: "notion", confirmRelaunch: true },
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("cancel CDP attach")), 75);

      await expect(attachment).rejects.toMatchObject({
        name: "OperationOutcomeAmbiguousError",
        outcome_ambiguous: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(cdpProbe).toHaveBeenCalled();
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
