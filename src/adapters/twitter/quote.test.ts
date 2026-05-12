import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  buildQuoteComposerUrl,
  buildQuoteSubmitScript,
  downloadTwitterImage,
  resolveRemoteImageExtension,
  resolveTwitterImagePath,
} from "./quote.js";

function pageMock(evaluateResults: unknown[]) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async () => evaluateResults.shift()),
    setFileInput: vi.fn().mockResolvedValue(undefined),
  };
}

describe("twitter agent-facing quote command", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds quote composer URLs from validated tweet URLs", () => {
    const url = buildQuoteComposerUrl(
      "https://x.com/alice/status/2040254679301718161?s=20",
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://x.com/compose/post");
    expect(parsed.searchParams.get("url")).toBe(
      "https://x.com/alice/status/2040254679301718161?s=20",
    );
    expect(() => buildQuoteComposerUrl("https://x.com/alice/home")).toThrow(
      "extract tweet ID",
    );
  });

  it("builds a submit script with exact quote-card guardrails", () => {
    const script = buildQuoteSubmitScript("great take", "2040254679301718161");
    expect(script).toContain("document.execCommand");
    expect(script).toContain("__twHasLinkToTarget(document)");
    expect(script).toContain("__twGetStatusIdFromHref");
    expect(script).toContain("Quote target did not render");
    expect(script).toContain("Quote tweet submission did not complete");
  });

  it("validates local and remote image formats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-twitter-quote-test-"));
    const image = join(dir, "banner.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(resolveTwitterImagePath(image)).toBe(image);
    expect(() => resolveTwitterImagePath(join(dir, "missing.png"))).toThrow(
      "not found",
    );
    expect(
      resolveRemoteImageExtension("https://example.com/a", "image/webp"),
    ).toBe(".webp");
    expect(resolveRemoteImageExtension("https://example.com/a.gif", null)).toBe(
      ".gif",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: vi.fn((name: string) =>
          name === "content-type" ? "image/png" : "4",
        ),
      },
      arrayBuffer: vi
        .fn()
        .mockResolvedValue(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer),
    });
    vi.stubGlobal("fetch", fetchMock);
    const downloaded = await downloadTwitterImage("https://example.com/a");
    expect(downloaded.absPath).toMatch(/image\.png$/);
    rmSync(downloaded.cleanupDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("navigates to composer, uploads image, and reports success", async () => {
    const command = resolveCommand("twitter", "quote")?.command;
    expect(command?.func).toBeTypeOf("function");
    const dir = mkdtempSync(join(tmpdir(), "unicli-twitter-quote-test-"));
    const image = join(dir, "banner.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const page = pageMock([
      { ok: true, previewCount: 1 },
      { ok: true, message: "Quote tweet posted successfully." },
    ]);
    const result = await command!.func!(page, {
      url: "https://x.com/alice/status/2040254679301718161",
      text: "great take",
      image,
    });
    expect(page.goto).toHaveBeenCalledWith(
      "https://x.com/compose/post?url=https%3A%2F%2Fx.com%2Falice%2Fstatus%2F2040254679301718161",
      { waitUntil: "load", settleMs: 2500 },
    );
    expect(page.setFileInput).toHaveBeenCalledWith(
      'input[type="file"][data-testid="fileInput"]',
      [image],
    );
    expect(page.evaluate.mock.calls[1][0]).toContain(
      "__twHasLinkToTarget(document)",
    );
    expect(result).toEqual([
      {
        status: "success",
        message: "Quote tweet posted successfully.",
        text: "great take",
        image,
      },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns failed rows without post-submit wait when quote card is absent", async () => {
    const command = resolveCommand("twitter", "quote")?.command;
    const page = pageMock([
      {
        ok: false,
        message:
          "Quote target did not render in the composer. The source tweet may be deleted or restricted.",
      },
    ]);
    const result = await command!.func!(page, {
      url: "https://x.com/alice/status/2040254679301718161",
      text: "orphaned quote",
    });
    expect(result).toEqual([
      {
        status: "failed",
        message:
          "Quote target did not render in the composer. The source tweet may be deleted or restricted.",
        text: "orphaned quote",
      },
    ]);
    expect(page.wait).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting image inputs before navigation", async () => {
    const command = resolveCommand("twitter", "quote")?.command;
    const page = pageMock([]);
    await expect(
      command!.func!(page, {
        url: "https://x.com/alice/status/2040254679301718161",
        text: "nope",
        image: "/tmp/a.png",
        "image-url": "https://example.com/a.png",
      }),
    ).rejects.toThrow("either --image or --image-url");
    expect(page.goto).not.toHaveBeenCalled();
  });
});
