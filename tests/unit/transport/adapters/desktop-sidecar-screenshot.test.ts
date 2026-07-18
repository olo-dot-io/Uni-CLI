import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  normalizeSidecarScreenshot,
  prepareSidecarScreenshotRequest,
} from "../../../../src/transport/adapters/desktop-sidecar-screenshot.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n8sAAAAASUVORK5CYII=";

describe("desktop sidecar screenshot normalization", () => {
  it("keeps the final destination out of sidecar parameters", () => {
    expect(
      prepareSidecarScreenshotRequest({ app: "Editor", path: "/tmp/a.png" }),
    ).toEqual({ params: { app: "Editor" }, path: "/tmp/a.png" });
  });

  it("publishes one validated PNG and has no post-commit cancellation point", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-sidecar-shot-"));
    const path = join(root, "capture.png");
    const controller = new AbortController();
    const signal = controller.signal;
    const originalThrow = signal.throwIfAborted.bind(signal);
    let checks = 0;
    Object.defineProperty(signal, "throwIfAborted", {
      value: () => {
        checks += 1;
        if (checks === 5) throw new Error("late cancellation");
        originalThrow();
      },
    });
    try {
      const normalized = await normalizeSidecarScreenshot(
        { screenshot: { base64: PNG_BASE64, mime: "image/png" } },
        path,
        signal,
      );

      expect(checks).toBe(4);
      expect(normalized).toMatchObject({
        path,
        mime: "image/png",
        bytes: Buffer.from(PNG_BASE64, "base64").length,
      });
      expect(normalized).not.toHaveProperty("base64");
      expect(readFileSync(path)).toEqual(Buffer.from(PNG_BASE64, "base64"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-PNG bytes before publishing a path", async () => {
    await expect(
      normalizeSidecarScreenshot({
        base64: Buffer.from("not png").toString("base64"),
      }),
    ).rejects.toThrow("not a PNG");
  });
});
