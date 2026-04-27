import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_EVIDENCE_HOOK_JS,
  captureBrowserEvidencePacket,
  installBrowserEvidenceHooks,
} from "../../src/engine/browser/evidence.js";
import type { IPage } from "../../src/types.js";

describe("browser operator evidence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-browser-evidence-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function mockPage(): IPage {
    return {
      goto: vi.fn(),
      evaluate: vi.fn(async (script: string) => {
        if (script.includes("__unicli_console_summary")) {
          return JSON.stringify({
            count: 2,
            error_count: 1,
            warn_count: 0,
            observed_since: "2026-04-27T14:00:00.000Z",
          });
        }
        return undefined;
      }),
      wait: vi.fn(),
      waitForSelector: vi.fn(),
      waitFor: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      press: vi.fn(),
      insertText: vi.fn(),
      scroll: vi.fn(),
      autoScroll: vi.fn(),
      nativeClick: vi.fn(),
      nativeKeyPress: vi.fn(),
      setFileInput: vi.fn(),
      cookies: vi.fn(async () => ({})),
      title: vi.fn(async () => "Example"),
      url: vi.fn(async () => "https://example.com/dashboard"),
      snapshot: vi.fn(async () => "[1]<button>Save</button>\n<p>Ready</p>"),
      screenshot: vi.fn(async () => Buffer.from("png-bytes")),
      networkRequests: vi.fn(async () => [
        {
          url: "https://example.com/api/feed",
          method: "GET",
          status: 200,
          type: "application/json",
          size: 128,
          timestamp: 1,
        },
        {
          url: "https://example.com/api/save",
          method: "POST",
          status: 201,
          type: "application/json",
          size: 64,
          timestamp: 2,
        },
      ]),
      addInitScript: vi.fn(),
      sendCDP: vi.fn(),
      close: vi.fn(),
      closeWindow: vi.fn(),
    };
  }

  it("installs console evidence hooks for current and future documents", async () => {
    const page = mockPage();

    await installBrowserEvidenceHooks(page);

    expect(BROWSER_EVIDENCE_HOOK_JS).toContain("__unicli_console_summary");
    expect(BROWSER_EVIDENCE_HOOK_JS).not.toContain("__unicli_console_events");
    expect(BROWSER_EVIDENCE_HOOK_JS).not.toContain("Array.from");
    expect(BROWSER_EVIDENCE_HOOK_JS).not.toContain("JSON.stringify(value)");
    expect(page.addInitScript).toHaveBeenCalledWith(
      expect.stringContaining("__unicli_console_summary"),
    );
    expect(page.evaluate).toHaveBeenCalledWith(
      expect.stringContaining("__unicli_console_summary"),
    );
  });

  it("keeps evidence hook installation best-effort when the backend rejects hooks", async () => {
    const page = mockPage();
    vi.mocked(page.addInitScript).mockRejectedValueOnce(
      new Error("init script unavailable"),
    );
    vi.mocked(page.evaluate).mockRejectedValueOnce(
      new Error("evaluate unavailable"),
    );

    await expect(installBrowserEvidenceHooks(page)).resolves.toBeUndefined();
  });

  it("captures URL, title, DOM ref summary, console count, network summary, and screenshot path", async () => {
    const page = mockPage();

    const packet = await captureBrowserEvidencePacket(page, {
      action: "state",
      workspace: "browser:default",
      screenshotDir: tmp,
      timestamp: "2026-04-27T14:30:00.000Z",
    });

    expect(packet).toMatchObject({
      schema_version: "1",
      evidence_type: "browser-operator",
      action: "state",
      workspace: "browser:default",
      observed_since: "2026-04-27T14:00:00.000Z",
      partial: true,
      capture_scope: {
        console: "since_hook",
        dom: "current_snapshot",
        network: "fallback",
        screenshot: "current_viewport",
      },
      page: {
        url: "https://example.com/dashboard",
        title: "Example",
      },
      dom: {
        format: "dom-ax",
        chars: "[1]<button>Save</button>\n<p>Ready</p>".length,
        ref_count: 1,
      },
      console: {
        count: 2,
        error_count: 1,
      },
      network: {
        count: 2,
        total_bytes: 192,
        status_counts: {
          "200": 1,
          "201": 1,
        },
        method_counts: {
          GET: 1,
          POST: 1,
        },
      },
      screenshot: {
        bytes: 9,
        sha256:
          "sha256:ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56",
      },
    });
    expect(packet.dom.preview).toContain("<button>Save</button>");
    expect(packet.screenshot.path).toContain(tmp);
    expect(readFileSync(packet.screenshot.path!).toString()).toBe("png-bytes");
  });

  it("counts numeric, Playwright-style, and structured snapshot refs", async () => {
    const page = mockPage();

    const packet = await captureBrowserEvidencePacket(page, {
      action: "state",
      workspace: "browser:default",
      snapshot: [
        '- button "Submit" [active] [ref=e2]',
        "[0-5] textbox: Search",
        "[12]<button>Save</button>",
      ].join("\n"),
    });

    expect(page.snapshot).not.toHaveBeenCalled();
    expect(packet.dom.ref_count).toBe(3);
    expect(packet.capture_scope.dom).toBe("provided_snapshot");
    expect(packet.screenshot.skipped).toBe(true);
    expect(packet.capture_scope.screenshot).toBe("skipped");
  });

  it("merges daemon network capture with backend fallback requests", async () => {
    const page = Object.assign(mockPage(), {
      readNetworkCapture: vi.fn(async () => [
        {
          url: "https://example.com/api/feed",
          method: "GET",
          status: 200,
          contentType: "application/json",
          size: 128,
        },
        {
          url: "https://example.com/api/live",
          method: "PATCH",
          status: 204,
          contentType: "application/json",
          size: 32,
        },
      ]),
    });

    const packet = await captureBrowserEvidencePacket(page, {
      action: "state",
      workspace: "browser:default",
      timestamp: "2026-04-27T14:30:00.000Z",
    });

    expect(packet.capture_scope.network).toBe("session+fallback");
    expect(packet.network).toMatchObject({
      count: 3,
      total_bytes: 224,
      status_counts: { "200": 1, "201": 1, "204": 1 },
      method_counts: { GET: 1, POST: 1, PATCH: 1 },
    });
  });

  it("records screenshot failures without failing the evidence packet", async () => {
    const page = mockPage();
    vi.mocked(page.screenshot).mockRejectedValueOnce(
      new Error("screen denied"),
    );

    const packet = await captureBrowserEvidencePacket(page, {
      action: "state",
      workspace: "browser:default",
      screenshotDir: tmp,
      timestamp: "2026-04-27T14:30:00.000Z",
    });

    expect(packet.screenshot).toEqual({ error: "screen denied" });
    expect(packet.capture_scope.screenshot).toBe("failed");
    expect(packet.capture_errors).toContain("screenshot: screen denied");
  });
});
