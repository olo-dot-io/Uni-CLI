import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserBridge } from "../../src/browser/bridge.js";
import { renderAgentPresence } from "../../extension/src/agent-presence.js";
import { searchOpenDocument } from "../../extension/src/content-search.js";
import {
  RealBrowserBrokerHarness,
  resolveTestBrowserPath,
} from "../helpers/browser-runtime-harness.js";

const browserPath = resolveTestBrowserPath();
const testIfBrowser = browserPath ? it : it.skip;
let harness: RealBrowserBrokerHarness | null = null;
let bridge: BrowserBridge | null = null;

afterEach(async () => {
  await bridge?.close().catch(() => undefined);
  await harness?.cleanup();
  bridge = null;
  harness = null;
}, 30_000);

describe("agent presence renderer in a real hidden browser", () => {
  testIfBrowser(
    "isolates a pointer-through edge frame, moves the cursor, and removes every visual byte",
    async () => {
      const runtime = new RealBrowserBrokerHarness(browserPath!);
      harness = runtime;
      await runtime.start();
      bridge = new BrowserBridge();
      const page = await bridge.connect({
        runtimeRoot: runtime.runtimeRoot,
        sessionId: `presence:${randomUUID()}`,
        turnId: "render",
        provider: "managed",
        visibility: "hidden",
        ephemeral: true,
      });
      const documentSource = [
        "<!doctype html>",
        '<html><head><meta charset="utf-8"><style>',
        "html,body{margin:0;width:100%;height:100%;background:#f4efe4}",
        "main{padding:80px;font:600 28px system-ui;color:#17130f}",
        "</style></head><body><main>Stable page</main></body></html>",
      ].join("");
      await page.goto(
        `data:text/html;charset=utf-8,${encodeURIComponent(documentSource)}`,
      );
      await page.sendCDP("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      const baseline = await page.screenshot({ format: "png" });

      const shown = await evaluateRenderer(page, {
        kind: "show",
        label: "Uni-CLI working",
      });
      expect(shown).toMatchObject({
        status: "visible",
        cursor_visible: false,
      });
      const hostState = await page.evaluate(`(() => {
        const host = document.querySelector('unicli-agent-presence[data-unicli-owner]');
        const shadow = host?.shadowRoot;
        const cursor = shadow?.querySelector('[part=cursor]');
        return {
          host_count: document.querySelectorAll('unicli-agent-presence[data-unicli-owner]').length,
          page_style_count: document.head.querySelectorAll('style').length,
          pointer_events: host ? getComputedStyle(host).pointerEvents : null,
          aria_hidden: host?.getAttribute('aria-hidden') ?? null,
          badge: shadow?.querySelector('[part=badge]')?.textContent ?? null,
          cursor_transition: cursor ? getComputedStyle(cursor).transitionProperty : null,
          cursor_duration: cursor ? getComputedStyle(cursor).transitionDuration : null,
          animation_name: cursor ? getComputedStyle(cursor).animationName : null,
        };
      })()`);
      expect(hostState).toEqual({
        host_count: 1,
        page_style_count: 1,
        pointer_events: "none",
        aria_hidden: "true",
        badge: "Uni-CLI working",
        cursor_transition: "transform, opacity",
        cursor_duration: expect.any(String),
        animation_name: "none",
      });
      const stateWhileVisible = JSON.parse(
        await page.snapshot({ raw: true }),
      ) as { tree: string };
      expect(stateWhileVisible.tree).not.toContain("Uni-CLI working");
      const searchWhileVisible = (await page.evaluate(
        `(${searchOpenDocument.toString()})(${JSON.stringify({
          query_lower: "uni-cli working",
          terms: ["uni-cli", "working"],
          max_chars: 4_096,
        })})`,
      )) as { exact_query_match: boolean };
      expect(searchWhileVisible.exact_query_match).toBe(false);
      expect(
        (hostState as { cursor_duration: string }).cursor_duration
          .split(",")
          .every((duration) => Number.parseFloat(duration) <= 0.001),
      ).toBe(true);

      await expect(
        evaluateRenderer(page, {
          kind: "move",
          x: 320,
          y: 180,
          cursor_visible: true,
        }),
      ).resolves.toMatchObject({
        status: "visible",
        cursor_visible: true,
        x: 320,
        y: 180,
      });
      const cursorState = await page.evaluate(`(() => {
        const cursor = document.querySelector('unicli-agent-presence[data-unicli-owner]')
          ?.shadowRoot?.querySelector('[part=cursor]');
        return cursor ? {
          opacity: cursor.style.opacity,
          transform: cursor.style.transform,
        } : null;
      })()`);
      expect(cursorState).toEqual({
        opacity: "1",
        transform: "translate3d(320px, 180px, 0px)",
      });
      const viewport = (await page.evaluate(
        "({ width: window.innerWidth, height: window.innerHeight })",
      )) as { width: number; height: number };
      await expect(
        evaluateRenderer(page, {
          kind: "move",
          x: viewport.width,
          y: 0,
          cursor_visible: true,
        }),
      ).resolves.toMatchObject({
        status: "out_of_bounds",
        cursor_visible: true,
        x: viewport.width,
        y: 0,
      });
      const visible = await page.screenshot({ format: "png" });
      expect(hash(visible)).not.toBe(hash(baseline));

      await expect(
        evaluateRenderer(page, { kind: "hide" }),
      ).resolves.toMatchObject({
        status: "hidden",
        cursor_visible: false,
      });
      expect(
        await page.evaluate(
          "document.querySelectorAll('unicli-agent-presence[data-unicli-owner]').length",
        ),
      ).toBe(0);
      const hidden = await page.screenshot({ format: "png" });
      expect(hash(hidden)).toBe(hash(baseline));
    },
    45_000,
  );
});

function evaluateRenderer(
  page: { evaluate(script: string): Promise<unknown> },
  update:
    | { kind: "show"; label: string }
    | { kind: "hide" }
    | { kind: "move"; x: number; y: number; cursor_visible: boolean },
): Promise<unknown> {
  return page.evaluate(
    `(${renderAgentPresence.toString()})(${JSON.stringify(update)})`,
  );
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
