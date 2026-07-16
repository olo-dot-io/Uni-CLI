import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserBridge,
  type BrowserBrokerPage,
} from "../../src/browser/bridge.js";
import {
  buildBrowserRefTargetExpression,
  readBrowserRefTargetResult,
} from "../../src/browser/ref-target.js";
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

describe("browser ref capabilities in a real renderer", () => {
  testIfBrowser(
    "acts on open-shadow and same-origin-frame refs and refuses a detached node",
    async () => {
      harness = new RealBrowserBrokerHarness(browserPath!);
      await harness.start();
      bridge = new BrowserBridge();
      const page = await bridge.connect({
        runtimeRoot: harness.runtimeRoot,
        sessionId: `refs:${randomUUID()}`,
        turnId: "composed-dom",
        provider: "managed",
        visibility: "hidden",
        ephemeral: true,
      });
      const brokerPage = page as BrowserBrokerPage;
      await page.goto(
        `data:text/html;charset=utf-8,${encodeURIComponent(documentSource())}`,
      );

      const raw = JSON.parse(
        await page.snapshot({ interactive: true, raw: true }),
      ) as SnapshotResult;
      expect(raw.snapshot_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(raw.url).toMatch(/^data:text\/html/);
      expect(raw.url_truncated).toBe(false);
      expect(raw.limitations).toEqual({ inaccessible_frames: 1 });
      const shadowRef = findRef(raw, (entry) => entry.text === "Shadow action");
      const slottedRef = findRef(
        raw,
        (entry) => entry.text === "Slotted action",
      );
      const coveredShadowRef = findRef(
        raw,
        (entry) => entry.text === "Covered shadow action",
      );
      const coveringShadowRef = findRef(
        raw,
        (entry) => entry.text === "Covering shadow action",
      );
      const frameRef = findRef(
        raw,
        (entry) => entry.attrs.placeholder === "Frame input",
      );
      const shadowFrameRef = findRef(
        raw,
        (entry) => entry.attrs.placeholder === "Shadow frame input",
      );
      const password = findEntry(
        raw,
        (entry) => entry.attrs.type === "password",
      );
      const oneTimeCode = findEntry(
        raw,
        (entry) => entry.attrs.name === "verification-code",
      );
      const sensitiveTextarea = findEntry(
        raw,
        (entry) => entry.attrs.name === "sensitive-note",
      );
      expect(password.attrs.value).toBeUndefined();
      expect(oneTimeCode.attrs.value).toBeUndefined();
      expect(sensitiveTextarea.text).toBe("");
      expect(password.attrs["aria-label"]).toHaveLength(256);
      expect(raw.tree).not.toContain("browser-state-secret");
      expect(raw.tree).not.toContain("otp-state-secret");
      expect(raw.tree).not.toContain("textarea-secret");
      expect(raw.tree).not.toContain("hidden-slot-secret-a");
      expect(raw.tree).not.toContain("hidden-slot-secret-b");

      const pageSearch = await evaluatePageSearch(page, "shadow action", [
        "shadow",
        "action",
      ]);
      expect(pageSearch).toMatchObject({
        exact_query_match: true,
        matched_terms: 2,
      });
      const sensitiveSearch = await evaluatePageSearch(
        page,
        "textarea-secret",
        ["textarea-secret"],
      );
      expect(sensitiveSearch.exact_query_match).toBe(false);
      expect(sensitiveSearch.snippets.join(" ")).not.toContain(
        "textarea-secret",
      );
      const hiddenSlotSearch = await evaluatePageSearch(
        page,
        "hidden-slot-secret",
        ["hidden-slot-secret"],
      );
      expect(hiddenSlotSearch.exact_query_match).toBe(false);
      expect(hiddenSlotSearch.snippets.join(" ")).not.toContain(
        "hidden-slot-secret",
      );

      await brokerPage.clickRef(selector(shadowRef), raw.snapshot_id);
      expect(await page.evaluate("window.shadowClicks")).toBe(1);
      await brokerPage.clickRef(selector(slottedRef), raw.snapshot_id);
      expect(await page.evaluate("window.slottedClicks")).toBe(1);
      await expect(
        brokerPage.clickRef(selector(coveredShadowRef), raw.snapshot_id),
      ).rejects.toMatchObject({ code: "browser_selector_occluded" });
      expect(
        await page.evaluate(
          "({ covered: window.coveredShadowClicks, covering: window.coveringShadowClicks })",
        ),
      ).toEqual({ covered: 0, covering: 0 });
      await brokerPage.clickRef(selector(coveringShadowRef), raw.snapshot_id);
      expect(await page.evaluate("window.coveringShadowClicks")).toBe(1);

      await page.evaluate(`(() => {
        const button = document.querySelector('#shadow-host').shadowRoot.querySelector('button');
        const rect = button.getBoundingClientRect();
        const overlay = document.createElement('div');
        overlay.id = 'click-overlay';
        overlay.style.cssText = 'position:fixed;z-index:2147483647;background:black;pointer-events:auto';
        overlay.style.left = (rect.left + rect.width / 2 - 10) + 'px';
        overlay.style.top = (rect.top + rect.height / 2 - 10) + 'px';
        overlay.style.width = '20px';
        overlay.style.height = '20px';
        document.body.append(overlay);
      })()`);
      await brokerPage.clickRef(selector(shadowRef), raw.snapshot_id);
      expect(await page.evaluate("window.shadowClicks")).toBe(2);

      await page.evaluate(`(() => {
        const button = document.querySelector('#shadow-host').shadowRoot.querySelector('button');
        const rect = button.getBoundingClientRect();
        const overlay = document.querySelector('#click-overlay');
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
      })()`);
      await expect(
        brokerPage.clickRef(selector(shadowRef), raw.snapshot_id),
      ).rejects.toMatchObject({
        code: "browser_selector_occluded",
        retryable: false,
        suggestion: expect.stringContaining("covering surface"),
      });
      expect(await page.evaluate("window.shadowClicks")).toBe(2);
      await page.evaluate("document.querySelector('#click-overlay').remove()");

      await brokerPage.typeWithMode(
        selector(frameRef),
        "typed through frame",
        "insert_text",
        raw.snapshot_id,
      );
      expect(
        await page.evaluate(
          "document.querySelector('iframe').contentDocument.querySelector('input').value",
        ),
      ).toBe("typed through frame");
      const frameTarget = readBrowserRefTargetResult(
        await page.evaluate(
          buildBrowserRefTargetExpression(selector(frameRef))!,
        ),
      );
      expect(frameTarget).toMatchObject({ status: "found", frame_depth: 1 });
      await brokerPage.typeWithMode(
        selector(shadowFrameRef),
        "typed through shadow frame",
        "insert_text",
        raw.snapshot_id,
      );
      expect(
        await page.evaluate(
          "document.querySelector('#shadow-frame-host').shadowRoot.querySelector('iframe').contentDocument.querySelector('input').value",
        ),
      ).toBe("typed through shadow frame");
      expect(
        readBrowserRefTargetResult(
          await page.evaluate(
            buildBrowserRefTargetExpression(selector(shadowFrameRef))!,
          ),
        ),
      ).toMatchObject({ status: "found", frame_depth: 1 });

      await page.evaluate(
        "Object.assign(document.querySelector('iframe').style, { transform: 'scale(0.75)', transformOrigin: '0 0' })",
      );
      await expect(
        brokerPage.clickRef(selector(frameRef), raw.snapshot_id),
      ).rejects.toMatchObject({
        code: "browser_frame_unsupported",
        retryable: false,
      });
      await page.evaluate(
        "document.querySelector('iframe').style.transform = 'none'",
      );

      const refreshed = JSON.parse(
        await page.snapshot({ interactive: true, raw: true }),
      ) as SnapshotResult;
      await expect(
        brokerPage.clickRef(selector(shadowRef), raw.snapshot_id),
      ).rejects.toMatchObject({
        code: "stale_ref",
        retryable: false,
      });
      const refreshedFrameRef = findRef(
        refreshed,
        (entry) => entry.attrs.placeholder === "Frame input",
      );

      await page.evaluate(
        "document.querySelector('iframe').contentDocument.querySelector('input').remove()",
      );
      await expect(
        brokerPage.clickRef(selector(refreshedFrameRef), refreshed.snapshot_id),
      ).rejects.toMatchObject({
        code: "stale_ref",
        retryable: false,
        suggestion: expect.stringContaining("fresh browser state"),
      });

      const bounded = JSON.parse(
        await page.snapshot({ interactive: true, raw: true, maxRefs: 2 }),
      ) as SnapshotResult;
      expect(bounded.refs).toHaveLength(2);
      expect(bounded.truncated).toBe(true);

      await page.evaluate(`(() => {
        const container = document.createElement('main');
        const fragment = document.createDocumentFragment();
        for (let index = 0; index < 6000; index += 1) {
          const row = document.createElement('div');
          row.textContent = 'x'.repeat(200);
          fragment.append(row);
        }
        container.append(fragment);
        document.body.replaceChildren(container);
      })()`);
      const capped = JSON.parse(
        await page.snapshot({ raw: true }),
      ) as SnapshotResult;
      expect(capped.tree).toHaveLength(1_000_000);
      expect(capped.truncated).toBe(true);
    },
    45_000,
  );
});

interface SnapshotResult {
  snapshot_id: string;
  url: string;
  url_truncated: boolean;
  title: string;
  tree: string;
  refs: SnapshotEntry[];
  limitations: { inaccessible_frames: number };
  truncated: boolean;
}

interface SnapshotEntry {
  ref: number;
  text: string;
  attrs: Record<string, string>;
}

function findRef(
  snapshot: SnapshotResult,
  predicate: (entry: SnapshotEntry) => boolean,
): number {
  const ref = snapshot.refs.find(predicate)?.ref;
  if (ref === undefined)
    throw new Error("Expected composed-DOM ref was absent");
  return ref;
}

function findEntry(
  snapshot: SnapshotResult,
  predicate: (entry: SnapshotEntry) => boolean,
): SnapshotEntry {
  const entry = snapshot.refs.find(predicate);
  if (!entry) throw new Error("Expected composed-DOM entry was absent");
  return entry;
}

function selector(ref: number): string {
  return `[data-unicli-ref="${String(ref)}"]`;
}

async function evaluatePageSearch(
  page: { evaluate(script: string): Promise<unknown> },
  query: string,
  terms: string[],
): Promise<{
  exact_query_match: boolean;
  matched_terms: number;
  snippets: string[];
}> {
  return (await page.evaluate(
    `(${searchOpenDocument.toString()})(${JSON.stringify({
      query_lower: query,
      terms,
      max_chars: 16_384,
    })})`,
  )) as {
    exact_query_match: boolean;
    matched_terms: number;
    snippets: string[];
  };
}

function documentSource(): string {
  const frame = [
    "<!doctype html><html><body>",
    '<input placeholder="Frame input" style="margin:24px;width:220px;height:32px">',
    "</body></html>",
  ].join("");
  const shadowFrame = [
    "<!doctype html><html><body>",
    '<input placeholder="Shadow frame input" style="margin:10px;width:220px;height:32px">',
    "</body></html>",
  ].join("");
  return [
    "<!doctype html><html><body>",
    '<div id="shadow-host"></div>',
    '<div id="slotted-host"><button slot="action">Slotted action</button></div>',
    '<div id="stacked-shadow-host" style="position:relative;width:220px;height:52px;margin:24px"></div>',
    '<div id="shadow-frame-host" style="position:fixed;top:8px;right:8px;width:280px;height:100px;z-index:10"></div>',
    '<div id="aria-slot-ancestor-host"><span slot="secret">hidden-slot-secret-a</span></div>',
    '<div id="aria-slot-host"><span slot="secret">hidden-slot-secret-b</span></div>',
    `<iframe srcdoc='${frame}' style="margin:40px;width:360px;height:140px"></iframe>`,
    `<iframe sandbox srcdoc='${frame}' style="width:1px;height:1px"></iframe>`,
    `<input type="password" value="browser-state-secret" aria-label="${"L".repeat(800)}">`,
    '<input name="verification-code" autocomplete="one-time-code" value="otp-state-secret">',
    '<textarea name="sensitive-note" autocomplete="current-password">textarea-secret</textarea>',
    '<button type="button">Overflow action</button>',
    "<script>",
    "window.shadowClicks = 0;",
    "window.slottedClicks = 0;",
    "window.coveredShadowClicks = 0;",
    "window.coveringShadowClicks = 0;",
    "const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});",
    "const button = document.createElement('button');",
    "button.textContent = 'Shadow action';",
    "button.style.cssText = 'margin:30px;width:160px;height:40px';",
    "button.addEventListener('click', () => { window.shadowClicks += 1; });",
    "root.append(button);",
    "const slottedRoot = document.querySelector('#slotted-host').attachShadow({mode:'open'});",
    "const slot = document.createElement('slot');",
    "slot.name = 'action';",
    "slottedRoot.append(slot);",
    "document.querySelector('#slotted-host > button').addEventListener('click', () => { window.slottedClicks += 1; });",
    "const stackedRoot = document.querySelector('#stacked-shadow-host').attachShadow({mode:'open'});",
    "const covered = document.createElement('button');",
    "covered.textContent = 'Covered shadow action';",
    "covered.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:1';",
    "covered.addEventListener('click', () => { window.coveredShadowClicks += 1; });",
    "const covering = document.createElement('button');",
    "covering.textContent = 'Covering shadow action';",
    "covering.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:2';",
    "covering.addEventListener('click', () => { window.coveringShadowClicks += 1; });",
    "stackedRoot.append(covered, covering);",
    "const shadowFrameRoot = document.querySelector('#shadow-frame-host').attachShadow({mode:'open'});",
    "const nestedFrame = document.createElement('iframe');",
    `nestedFrame.srcdoc = ${JSON.stringify(shadowFrame)};`,
    "nestedFrame.style.cssText = 'width:100%;height:100%;border:0';",
    "shadowFrameRoot.append(nestedFrame);",
    "const hiddenAncestorRoot = document.querySelector('#aria-slot-ancestor-host').attachShadow({mode:'open'});",
    "const hiddenAncestor = document.createElement('div');",
    "hiddenAncestor.setAttribute('aria-hidden', 'true');",
    "const hiddenAncestorSlot = document.createElement('slot');",
    "hiddenAncestorSlot.name = 'secret';",
    "hiddenAncestor.append(hiddenAncestorSlot);",
    "hiddenAncestorRoot.append(hiddenAncestor);",
    "const hiddenSlotRoot = document.querySelector('#aria-slot-host').attachShadow({mode:'open'});",
    "const hiddenSlot = document.createElement('slot');",
    "hiddenSlot.name = 'secret';",
    "hiddenSlot.setAttribute('aria-hidden', 'true');",
    "hiddenSlotRoot.append(hiddenSlot);",
    "</script></body></html>",
  ].join("");
}
