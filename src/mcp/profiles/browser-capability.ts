/**
 * @owner       src::mcp::profiles::browser-capability
 * @does        Execute prepared-target browser state, screenshots, navigation, trusted ref/viewport input, supervision, and atomic snapshot-capability ref actions for the direct computer-use MCP surface.
 * @needs       BrowserBrokerPage, browser invocation scope, broker target metadata
 * @feeds       src/mcp/profiles/browser-control.ts
 * @breaks      Missing target preparation, malformed renderer state, stale refs, and provider/target mismatches return typed errors without acquisition or input-route fallback.
 * @invariants  Chrome actions claim one explicit tab; managed/remote actions adopt one exact session lease; navigate never implicitly acquires; snapshot UUID and local ref travel inside the same serialized mutation command; viewport clicks validate live CSS bounds inside the serialized provider command before trusted CDP input.
 * @side-effects May explicitly acquire a broker-owned target, navigate it, snapshot/capture it, issue input, or respond to one selected JavaScript dialog.
 * @perf        State uses one renderer round trip; ref actions, keyboard, scroll, screenshot, dialogs, and downloads use one provider command after bounded target adoption; action acknowledgements reuse cached exact target identity.
 * @concurrency The broker serializes snapshot-id verification and ref actuation on one target queue, preventing another Agent command from rebinding a local ref between verification and input.
 * @test        tests/unit/mcp/browser-control.test.ts, tests/integration/browser-ref-capabilities.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

import type { BrowserBrokerPage } from "../../browser/bridge.js";
import type { BrowserInvocationScope } from "../../browser/invocation-scope.js";
import type { BrowserSessionLeaseTarget } from "../../engine/browser/session-lease.js";
import {
  BrowserControlInputError,
  type BrowserControlParams,
} from "./browser-control-input.js";

interface RawBrowserSnapshot {
  snapshot_id: string;
  url: string;
  url_truncated: boolean;
  title: string;
  tree: string;
  refs: RawBrowserSnapshotRef[];
  limitations: { inaccessible_frames: number };
  truncated: boolean;
}

interface RawBrowserSnapshotRef {
  ref: number;
  tag: string;
  text: string;
  attrs: Record<string, string>;
  frame: "main" | "shadow" | "same_origin_iframe";
}

const MAX_DIRECT_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export interface BrowserControlImageResult {
  target: BrowserSessionLeaseTarget;
  format: "png" | "jpeg" | "webp";
  bytes: number;
  image: { data: string; mimeType: string };
}

export async function prepareBrowserTarget(
  page: BrowserBrokerPage,
): Promise<BrowserSessionLeaseTarget> {
  const url = await page.url();
  const target = requireTarget(page.browserTargetIdentity(), "Prepared");
  if (
    target.provider === "chrome" &&
    (!target.owned ||
      !positiveSafeInteger(target.tab_id) ||
      !positiveSafeInteger(target.window_id))
  ) {
    throw new BrowserControlProtocolError(
      "Prepared Chrome target is not an owned tab with exact tab and window identity",
    );
  }
  return {
    ...target,
    url,
  };
}

export async function readBrowserState(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindReadTarget(page, args, scope);
  const snapshot = readBrowserSnapshot(
    await page.snapshot({
      interactive: true,
      compact: true,
      raw: true,
      maxRefs: args.max_refs as number,
      maxDepth: args.max_depth as number,
    }),
  );
  const target = requireTarget(page.browserTargetIdentity(), "Snapshot");
  return projectBrowserSnapshot(snapshot, {
    ...target,
    url: snapshot.url,
    title: snapshot.title,
  });
}

export async function navigateBrowserTarget(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<BrowserSessionLeaseTarget> {
  await bindMutationTarget(page, args, scope);
  await page.goto(args.url as string, { settleMs: args.settle_ms as number });
  const url = await page.url();
  return {
    ...requireTarget(page.browserTargetIdentity(), "Navigation"),
    url,
  };
}

export async function captureBrowserScreenshot(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<BrowserControlImageResult> {
  await bindReadTarget(page, args, scope);
  const format = args.format as "png" | "jpeg" | "webp";
  const bytes = await page.screenshot({
    format,
    ...(args.quality === undefined ? {} : { quality: args.quality as number }),
    fullPage: args.full_page as boolean,
  });
  const mimeType = readImageMime(bytes);
  if (bytes.length === 0 || mimeType !== `image/${format}`) {
    throw new BrowserControlProtocolError(
      `Browser screenshot is not a valid ${format} image`,
    );
  }
  if (bytes.length > MAX_DIRECT_SCREENSHOT_BYTES) {
    throw new BrowserControlProtocolError(
      `Browser screenshot exceeds the ${String(MAX_DIRECT_SCREENSHOT_BYTES)} byte direct-tool limit`,
    );
  }
  return {
    target: requireTarget(page.browserTargetIdentity(), "Screenshot"),
    format,
    bytes: bytes.length,
    image: { data: bytes.toString("base64"), mimeType },
  };
}

export async function clickBrowserTarget(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindMutationTarget(page, args, scope);
  if (typeof args.ref === "string") {
    await page.clickRef(refSelector(args), args.snapshot_id as string);
    return actionTargetResult(page, {
      ref: args.ref,
      input_route: "cdp_pointer",
      snapshot_atomic: true,
      hit_tested: true,
    });
  }
  const x = args.x as number;
  const y = args.y as number;
  await page.nativeClick(x, y);
  return actionTargetResult(page, {
    point: { x, y },
    input_route: "trusted_pointer",
  });
}

export async function typeBrowserRef(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindMutationTarget(page, args, scope);
  await page.typeWithMode(
    refSelector(args),
    args.text as string,
    args.mode as "insert_text" | "keystrokes",
    args.snapshot_id as string,
  );
  return actionTargetResult(page, {
    ref: args.ref,
    mode: args.mode,
    chars: [...(args.text as string)].length,
    input_route:
      args.mode === "keystrokes" ? "cdp_key_events" : "cdp_insert_text",
    snapshot_atomic: true,
    hit_tested: true,
  });
}

export async function pressBrowserKey(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindMutationTarget(page, args, scope);
  await page.press(args.key as string, args.modifiers as string[]);
  return actionTargetResult(page, {
    subject: "keyboard",
    key: args.key,
    modifiers: args.modifiers,
    input_route: "trusted_key_events",
  });
}

export async function scrollBrowserTarget(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindMutationTarget(page, args, scope);
  await page.scroll(args.direction as "down" | "up" | "bottom" | "top");
  return actionTargetResult(page, {
    subject: "viewport",
    direction: args.direction,
    input_route: "page_scroll",
  });
}

export async function readBrowserDialogs(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindReadTarget(page, args, scope);
  return providerTargetResult(
    page,
    await page.readDialogs(false),
    "dialog state",
  );
}

export async function respondBrowserDialog(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindMutationTarget(page, args, scope);
  return providerTargetResult(
    page,
    await page.respondDialog({
      action: args.action as "accept" | "dismiss",
      ...(args.prompt_text === undefined
        ? {}
        : { promptText: args.prompt_text as string }),
      ...(args.dialog_id === undefined
        ? {}
        : { dialogId: args.dialog_id as string }),
    }),
    "dialog response",
  );
}

export async function readBrowserDownloads(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<Record<string, unknown>> {
  await bindReadTarget(page, args, scope);
  return providerTargetResult(
    page,
    await page.readDownloads(args.limit as number),
    "download history",
  );
}

class BrowserControlProtocolError extends Error {
  readonly code = "browser_control_protocol_invalid";
  readonly retryable = false;
  readonly exitCode = 70;
  readonly suggestion =
    "Run `unicli browser doctor --json`; do not act on malformed browser state.";

  constructor(message: string) {
    super(message);
    this.name = "BrowserControlProtocolError";
  }
}

class BrowserRequiresSetupError extends Error {
  readonly code = "browser_requires_setup";
  readonly retryable = false;
  readonly exitCode = 69;
  readonly suggestion =
    "Call computer-use.browser_prepare first, then retry browser_state in the same Agent session.";

  constructor() {
    super(
      "No prepared browser target exists for this Agent session and provider policy",
    );
    this.name = "BrowserRequiresSetupError";
  }
}

function readBrowserSnapshot(value: string): RawBrowserSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new BrowserControlProtocolError(
      `Browser snapshot is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.snapshot_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed.snapshot_id,
    ) ||
    !boundedString(parsed.url, 8_192) ||
    typeof parsed.url_truncated !== "boolean" ||
    !boundedString(parsed.title, 512) ||
    typeof parsed.tree !== "string" ||
    parsed.tree.length > 1_000_000 ||
    !Array.isArray(parsed.refs) ||
    parsed.refs.length > 1_000 ||
    !isRecord(parsed.limitations) ||
    !nonnegativeSafeInteger(parsed.limitations.inaccessible_frames) ||
    typeof parsed.truncated !== "boolean"
  ) {
    throw new BrowserControlProtocolError(
      "Browser snapshot envelope is malformed",
    );
  }
  const refs = parsed.refs.map(readBrowserSnapshotRef);
  if (new Set(refs.map((entry) => entry.ref)).size !== refs.length) {
    throw new BrowserControlProtocolError(
      "Browser snapshot contains duplicate refs",
    );
  }
  return {
    snapshot_id: parsed.snapshot_id,
    url: parsed.url,
    url_truncated: parsed.url_truncated,
    title: parsed.title,
    tree: parsed.tree,
    refs,
    limitations: {
      inaccessible_frames: parsed.limitations.inaccessible_frames,
    },
    truncated: parsed.truncated,
  };
}

function readBrowserSnapshotRef(value: unknown): RawBrowserSnapshotRef {
  if (
    !isRecord(value) ||
    !positiveSafeInteger(value.ref) ||
    value.ref > 1_000 ||
    !boundedString(value.tag, 64) ||
    !boundedString(value.text, 200) ||
    !isBoundedStringRecord(value.attrs, 32, 512) ||
    (value.frame !== "main" &&
      value.frame !== "shadow" &&
      value.frame !== "same_origin_iframe")
  ) {
    throw new BrowserControlProtocolError("Browser snapshot ref is malformed");
  }
  return {
    ref: value.ref,
    tag: value.tag,
    text: value.text,
    attrs: value.attrs,
    frame: value.frame,
  };
}

function projectBrowserSnapshot(
  snapshot: RawBrowserSnapshot,
  target: BrowserSessionLeaseTarget,
): Record<string, unknown> {
  return {
    target,
    url_truncated: snapshot.url_truncated,
    snapshot_id: snapshot.snapshot_id,
    tree: snapshot.tree,
    refs: snapshot.refs.map((entry) => ({
      ref: `p${snapshot.snapshot_id}:${String(entry.ref)}`,
      node: entry.tag,
      label:
        entry.text ||
        entry.attrs["aria-label"] ||
        entry.attrs.placeholder ||
        entry.attrs.name ||
        "",
      frame: entry.frame,
    })),
    truncated: snapshot.truncated,
    limitations: {
      inaccessible_frames: snapshot.limitations.inaccessible_frames,
      unsupported: snapshot.limitations.inaccessible_frames
        ? ["cross_origin_or_oopif"]
        : [],
    },
  };
}

async function bindReadTarget(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<void> {
  if (scope.provider === "chrome") {
    await page.claimChromeTab(requireChromeTabId(args));
    return;
  }
  rejectTabIdForNonChrome(args, scope);
  if (await page.adoptPreparedTarget()) return;
  throw new BrowserRequiresSetupError();
}

function boundedProviderResult(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BrowserControlProtocolError(`Browser ${label} is malformed`);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 256_000) {
    throw new BrowserControlProtocolError(
      `Browser ${label} exceeds the 256000 character direct-tool limit`,
    );
  }
  return value;
}

function providerTargetResult(
  page: BrowserBrokerPage,
  value: unknown,
  label: string,
): Record<string, unknown> {
  return {
    ...boundedProviderResult(value, label),
    target: requireTarget(page.browserTargetIdentity(), "Provider result"),
  };
}

function readImageMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString("ascii") === "PNG"
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

async function bindMutationTarget(
  page: BrowserBrokerPage,
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): Promise<void> {
  if (scope.provider === "chrome") {
    await page.claimChromeTab(requireChromeTabId(args));
    return;
  }
  rejectTabIdForNonChrome(args, scope);
  if (!(await page.adoptPreparedTarget()))
    throw new BrowserRequiresSetupError();
}

function requireChromeTabId(args: BrowserControlParams): number {
  if (typeof args.tab_id !== "number") {
    throw new BrowserControlInputError(
      "tab_id from computer-use.browser_tabs is required for Chrome page control",
    );
  }
  return args.tab_id;
}

function rejectTabIdForNonChrome(
  args: BrowserControlParams,
  scope: BrowserInvocationScope,
): void {
  if (args.tab_id !== undefined) {
    throw new BrowserControlInputError(
      `tab_id is only valid for Chrome, not the ${scope.provider} provider`,
    );
  }
}

function refSelector(args: BrowserControlParams): string {
  return `[data-unicli-ref="${String(args.local_ref)}"]`;
}

async function actionTargetResult(
  page: BrowserBrokerPage,
  detail: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const target = requireTarget(page.browserTargetIdentity(), "Action");
  return { target, ...detail };
}

function requireTarget(
  target: BrowserSessionLeaseTarget | null,
  operation: string,
): BrowserSessionLeaseTarget {
  if (
    !target ||
    !boundedString(target.target_id, 512) ||
    target.target_id.length === 0 ||
    !target.provider ||
    !target.visibility ||
    typeof target.owned !== "boolean"
  ) {
    throw new BrowserControlProtocolError(
      `${operation} target metadata is absent or malformed`,
    );
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function isBoundedStringRecord(
  value: unknown,
  maximumEntries: number,
  maximumValueLength: number,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= maximumEntries &&
    Object.entries(value).every(
      ([key, entry]) =>
        key.length <= 64 && boundedString(entry, maximumValueLength),
    )
  );
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return nonnegativeSafeInteger(value) && value > 0;
}
