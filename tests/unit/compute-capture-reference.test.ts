import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  copyReferenceMarkupToClipboard,
  saveComputeCaptureReference,
} from "../../src/compute/capture-reference.js";
import type { ComputeCapturePacket } from "../../src/compute/capture.js";

describe("compute capture references", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-capture-ref-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists packet, app state text, screenshot, and an app-shots reference", async () => {
    const screenshotPath = join(tmp, "source.png");
    const screenshotBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(screenshotPath, screenshotBytes);
    const packet: ComputeCapturePacket = {
      schema_version: 1,
      captured_at: "2026-05-24T17:32:46Z",
      app: "Calculator",
      includes: ["snapshot", "screenshot"],
      trajectory: {
        replayable: true,
        steps: [
          {
            index: 0,
            action: "compute_snapshot",
            params: { app: "Calculator", format: "compact", maxDepth: 64 },
            ok: true,
          },
          {
            index: 1,
            action: "compute_screenshot",
            params: { app: "Calculator" },
            ok: true,
          },
        ],
      },
      snapshot: {
        ok: true,
        data: {
          encoding: "compact",
          data: '@e1 button "5" value="<AXUIElement 0x123> {pid=42}" 32x28@100,120 screen=0',
          refs: { count: 1, scope: "Calculator" },
        },
      },
      screenshot: {
        ok: true,
        data: {
          path: screenshotPath,
          mime: "image/png",
        },
      },
    };

    const reference = await saveComputeCaptureReference(packet, {
      rootDir: join(tmp, "captures"),
    });

    expect(reference.id).toMatch(/^calculator-/);
    expect(reference.markup).toBe(
      `[app-shots image="${reference.files.image}" content="${reference.files.content}" metadata="${reference.files.metadata}"]`,
    );
    expect(existsSync(reference.files.metadata)).toBe(true);
    expect(existsSync(reference.files.content)).toBe(true);
    expect(existsSync(reference.files.image ?? "")).toBe(true);
    expect(readFileSync(reference.files.content, "utf-8")).toContain(
      '@e1 button "5"',
    );
    expect(readFileSync(reference.files.content, "utf-8")).not.toContain(
      "32x28@100,120",
    );
    expect(readFileSync(reference.files.content, "utf-8")).not.toContain(
      "screen=0",
    );
    expect(readFileSync(reference.files.content, "utf-8")).not.toContain(
      "AXUIElement",
    );
    const storedPacket = JSON.parse(
      readFileSync(reference.files.metadata, "utf-8"),
    ) as {
      packet?: ComputeCapturePacket;
      reference?: { markup?: string };
    };
    expect(storedPacket.packet?.app).toBe("Calculator");
    expect(storedPacket.reference?.markup).toBe(reference.markup);
    expect(
      (storedPacket.packet?.snapshot?.data as { data?: string } | undefined)
        ?.data,
    ).toBe('@e1 button "5"\n');
    expect(
      (
        storedPacket.packet?.screenshot?.data as
          | { base64?: string; path?: string }
          | undefined
      )?.base64,
    ).toBeUndefined();
    expect(
      (
        storedPacket.packet?.screenshot?.data as
          | { base64?: string; path?: string }
          | undefined
      )?.path,
    ).toBe(reference.files.image);
  });

  it("creates a distinct reference directory for repeated captures", async () => {
    const packet: ComputeCapturePacket = {
      schema_version: 1,
      captured_at: "2026-05-24T17:32:46Z",
      app: "Finder",
      includes: ["snapshot"],
      trajectory: {
        replayable: true,
        steps: [
          {
            index: 0,
            action: "compute_snapshot",
            params: { app: "Finder", format: "compact", maxDepth: 64 },
            ok: true,
          },
        ],
      },
      snapshot: {
        ok: true,
        data: {
          encoding: "compact",
          data: '@e1 window "src"',
        },
      },
    };
    const rootDir = join(tmp, "captures");

    const first = await saveComputeCaptureReference(packet, { rootDir });
    const second = await saveComputeCaptureReference(packet, { rootDir });

    expect(second.id).not.toBe(first.id);
    expect(existsSync(first.files.metadata)).toBe(true);
    expect(existsSync(second.files.metadata)).toBe(true);
  });

  it("externalizes screenshot bytes when content falls back to JSON", async () => {
    const screenshotBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const packet: ComputeCapturePacket = {
      schema_version: 1,
      captured_at: "2026-05-24T17:32:46Z",
      app: "Preview",
      includes: ["screenshot"],
      trajectory: {
        replayable: true,
        steps: [
          {
            index: 0,
            action: "compute_screenshot",
            params: { app: "Preview" },
            ok: true,
          },
        ],
      },
      screenshot: {
        ok: true,
        data: {
          base64: screenshotBase64,
          mime: "image/png",
        },
      },
    };

    const reference = await saveComputeCaptureReference(packet, {
      rootDir: join(tmp, "captures"),
    });

    const content = readFileSync(reference.files.content, "utf-8");
    expect(content).not.toContain(screenshotBase64);
    expect(content).not.toContain('"base64"');
    expect(content).toContain(reference.files.image);
  });

  it("copies reference markup through the host clipboard command", async () => {
    const calls: Array<{ command: string; args: string[]; input: string }> = [];

    await copyReferenceMarkupToClipboard('[app-shots content="/tmp/a.txt"]', {
      platform: "darwin",
      run: async (command, args, input) => {
        calls.push({ command, args, input });
      },
    });

    expect(calls).toEqual([
      {
        command: "pbcopy",
        args: [],
        input: '[app-shots content="/tmp/a.txt"]',
      },
    ]);
  });
});
