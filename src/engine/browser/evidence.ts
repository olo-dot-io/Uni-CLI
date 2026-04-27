import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IPage, NetworkRequest } from "../../types.js";

export interface BrowserEvidenceOptions {
  action: string;
  workspace: string;
  screenshotDir?: string;
  timestamp?: string;
  snapshot?: string;
  maxPreviewChars?: number;
}

export interface BrowserEvidencePacket {
  schema_version: "1";
  evidence_type: "browser-operator";
  action: string;
  workspace: string;
  captured_at: string;
  observed_since: string | null;
  partial: boolean;
  capture_scope: {
    console: ConsoleScope;
    dom: DomScope;
    network: NetworkScope;
    screenshot: ScreenshotScope;
  };
  page: {
    url: string;
    title: string;
  };
  dom: {
    format: "dom-ax";
    chars: number;
    ref_count: number;
    preview: string;
  };
  console: {
    count: number;
    error_count: number;
    warn_count: number;
  };
  network: {
    count: number;
    total_bytes: number;
    status_counts: Record<string, number>;
    method_counts: Record<string, number>;
  };
  screenshot: {
    path?: string;
    bytes?: number;
    sha256?: string;
    skipped?: boolean;
    error?: string;
  };
  capture_errors: string[];
}

type ConsoleScope = "session" | "since_hook" | "unavailable";
type DomScope = "current_snapshot" | "provided_snapshot" | "unavailable";
type NetworkScope = "session" | "session+fallback" | "fallback" | "unavailable";
type ScreenshotScope = "current_viewport" | "skipped" | "failed";

interface ConsoleSummary {
  count?: number;
  error_count?: number;
  warn_count?: number;
  observed_since?: string;
}

interface NetworkCaptureEntry {
  url: string;
  method?: string;
  status?: number;
  contentType?: string;
  type?: string;
  size?: number;
  bodySize?: number;
}

interface NetworkReadResult {
  entries: NetworkCaptureEntry[];
  scope: NetworkScope;
}

interface ConsoleReadResult {
  summary: ConsoleSummary;
  scope: ConsoleScope;
  observedSince: string | null;
}

export const BROWSER_EVIDENCE_HOOK_JS = `(() => {
  const root = globalThis;
  const summary = root.__unicli_console_summary || {
    count: 0,
    error_count: 0,
    warn_count: 0,
    observed_since: new Date().toISOString()
  };
  root.__unicli_console_summary = summary;
  if (root.__unicli_console_hooked) return;
  root.__unicli_console_hooked = true;

  const bump = (level) => {
    try {
      summary.count = Number(summary.count || 0) + 1;
      if (level === "error") {
        summary.error_count = Number(summary.error_count || 0) + 1;
      }
      if (level === "warn") {
        summary.warn_count = Number(summary.warn_count || 0) + 1;
      }
    } catch {
      /* evidence hooks must never affect the page */
    }
  };

  for (const level of ["log", "warn", "error"]) {
    const original = console[level];
    if (typeof original !== "function") continue;
    console[level] = function(...args) {
      bump(level);
      return original.apply(this, args);
    };
  }

  root.addEventListener?.("error", () => {
    bump("error");
  });
  root.addEventListener?.("unhandledrejection", () => {
    bump("error");
  });
})()`;

const READ_CONSOLE_SUMMARY_JS = `(() => JSON.stringify(globalThis.__unicli_console_summary || null))()`;

export async function installBrowserEvidenceHooks(page: IPage): Promise<void> {
  try {
    await page.addInitScript(BROWSER_EVIDENCE_HOOK_JS);
  } catch {
    // Best effort: older backends may only support evaluate on the current page.
  }

  try {
    await page.evaluate(BROWSER_EVIDENCE_HOOK_JS);
  } catch {
    // Evidence hooks are observational and must not block the browser command.
  }
}

export async function captureBrowserEvidencePacket(
  page: IPage,
  options: BrowserEvidenceOptions,
): Promise<BrowserEvidencePacket> {
  const captureErrors: string[] = [];
  const capturedAt = options.timestamp ?? new Date().toISOString();
  const maxPreviewChars = Math.max(1, options.maxPreviewChars ?? 2000);

  const url = await captureValue(() => page.url(), "", "url", captureErrors);
  const title = await captureValue(
    () => page.title(),
    "",
    "title",
    captureErrors,
  );
  const snapshot =
    options.snapshot ??
    (await captureValue(
      () => page.snapshot({ interactive: true }),
      "",
      "snapshot",
      captureErrors,
    ));
  const consoleResult = await readConsoleSummary(page, captureErrors);
  const networkResult = await readNetworkEntries(page, captureErrors);
  const screenshot = await captureScreenshot(page, options, capturedAt);
  if (screenshot.error) captureErrors.push(`screenshot: ${screenshot.error}`);
  const captureScope = {
    console: consoleResult.scope,
    dom: domScope(options, snapshot),
    network: networkResult.scope,
    screenshot: screenshotScope(screenshot),
  };

  return {
    schema_version: "1",
    evidence_type: "browser-operator",
    action: options.action,
    workspace: options.workspace,
    captured_at: capturedAt,
    observed_since: consoleResult.observedSince,
    partial: isPartialEvidence(captureScope),
    capture_scope: captureScope,
    page: { url, title },
    dom: {
      format: "dom-ax",
      chars: snapshot.length,
      ref_count: countSnapshotRefs(snapshot),
      preview: snapshot.slice(0, maxPreviewChars),
    },
    console: summarizeConsole(consoleResult.summary),
    network: summarizeNetwork(networkResult.entries),
    screenshot,
    capture_errors: captureErrors,
  };
}

async function captureValue<T>(
  fn: () => Promise<T>,
  fallback: T,
  label: string,
  errors: string[],
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${errorMessage(err)}`);
    return fallback;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countSnapshotRefs(snapshot: string): number {
  try {
    const parsed = JSON.parse(snapshot) as { refs?: unknown };
    if (Array.isArray(parsed.refs)) return parsed.refs.length;
  } catch {
    // Plain DOM/AX snapshot strings are expected.
  }

  const refs = new Set<string>();
  for (const match of snapshot.matchAll(/\[(\d+)\]/g)) {
    refs.add(`numeric:${match[1]}`);
  }
  for (const match of snapshot.matchAll(/\[ref=([A-Za-z0-9_-]+)\]/g)) {
    refs.add(`playwright:${match[1]}`);
  }
  for (const match of snapshot.matchAll(/\[(\d+-\d+)\]/g)) {
    refs.add(`structured:${match[1]}`);
  }
  return refs.size;
}

async function readConsoleSummary(
  page: IPage,
  errors: string[],
): Promise<ConsoleReadResult> {
  try {
    const raw = await page.evaluate(READ_CONSOLE_SUMMARY_JS);
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as unknown;
      return consoleReadResult(parsed);
    }
    return consoleReadResult(raw);
  } catch (err) {
    errors.push(`console: ${errorMessage(err)}`);
    return {
      summary: {},
      scope: "unavailable",
      observedSince: null,
    };
  }
}

async function readNetworkEntries(
  page: IPage,
  errors: string[],
): Promise<NetworkReadResult> {
  const pageWithCapture = page as IPage & {
    readNetworkCapture?: () => Promise<NetworkCaptureEntry[]>;
  };

  let captured: NetworkCaptureEntry[] = [];
  if (typeof pageWithCapture.readNetworkCapture === "function") {
    try {
      captured = (await pageWithCapture.readNetworkCapture()) ?? [];
    } catch (err) {
      errors.push(`network_capture: ${errorMessage(err)}`);
    }
  }

  let fallback: NetworkCaptureEntry[] = [];
  try {
    fallback = (await page.networkRequests()).map(fromNetworkRequest);
  } catch (err) {
    errors.push(`network: ${errorMessage(err)}`);
  }

  const entries = mergeNetworkEntries(captured, fallback);
  if (captured.length > 0 && fallback.length > 0) {
    return { entries, scope: "session+fallback" };
  }
  if (captured.length > 0) return { entries, scope: "session" };
  if (fallback.length > 0) return { entries, scope: "fallback" };
  return { entries, scope: "unavailable" };
}

function fromNetworkRequest(request: NetworkRequest): NetworkCaptureEntry {
  return {
    url: request.url,
    method: request.method,
    status: request.status,
    contentType: request.type,
    size: request.size,
  };
}

function summarizeConsole(
  summary: ConsoleSummary,
): BrowserEvidencePacket["console"] {
  return {
    count: numberOrZero(summary.count),
    error_count: numberOrZero(summary.error_count),
    warn_count: numberOrZero(summary.warn_count),
  };
}

function summarizeNetwork(
  entries: NetworkCaptureEntry[],
): BrowserEvidencePacket["network"] {
  const statusCounts: Record<string, number> = {};
  const methodCounts: Record<string, number> = {};
  let totalBytes = 0;

  for (const entry of entries) {
    const status = String(entry.status ?? 0);
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;

    const method = (entry.method ?? "GET").toUpperCase();
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;

    totalBytes += numberOrZero(entry.size ?? entry.bodySize);
  }

  return {
    count: entries.length,
    total_bytes: totalBytes,
    status_counts: statusCounts,
    method_counts: methodCounts,
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function captureScreenshot(
  page: IPage,
  options: BrowserEvidenceOptions,
  capturedAt: string,
): Promise<BrowserEvidencePacket["screenshot"]> {
  if (!options.screenshotDir) return { skipped: true };

  try {
    const buffer = await page.screenshot({ fullPage: false });
    const sha256 = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    await mkdir(options.screenshotDir, { recursive: true, mode: 0o700 });
    const path = join(
      options.screenshotDir,
      `browser-evidence-${safeTimestamp(capturedAt)}-${sha256.slice(7, 19)}.png`,
    );
    await writeFile(path, buffer, { mode: 0o600 });
    return {
      path,
      bytes: buffer.length,
      sha256,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

function consoleReadResult(value: unknown): ConsoleReadResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const summary = value as ConsoleSummary;
    const observedSince =
      typeof summary.observed_since === "string" &&
      summary.observed_since.length > 0
        ? summary.observed_since
        : null;
    return {
      summary,
      scope: observedSince ? "since_hook" : "unavailable",
      observedSince,
    };
  }

  return {
    summary: {},
    scope: "unavailable",
    observedSince: null,
  };
}

function mergeNetworkEntries(
  captured: NetworkCaptureEntry[],
  fallback: NetworkCaptureEntry[],
): NetworkCaptureEntry[] {
  const merged: NetworkCaptureEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...captured, ...fallback]) {
    const key = networkEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function networkEntryKey(entry: NetworkCaptureEntry): string {
  return [
    (entry.method ?? "GET").toUpperCase(),
    String(entry.status ?? 0),
    entry.url,
    String(numberOrZero(entry.size ?? entry.bodySize)),
  ].join("\0");
}

function domScope(options: BrowserEvidenceOptions, snapshot: string): DomScope {
  if (options.snapshot !== undefined) return "provided_snapshot";
  return snapshot.length > 0 ? "current_snapshot" : "unavailable";
}

function screenshotScope(
  screenshot: BrowserEvidencePacket["screenshot"],
): ScreenshotScope {
  if (screenshot.error) return "failed";
  if (screenshot.skipped) return "skipped";
  return "current_viewport";
}

function isPartialEvidence(
  scope: BrowserEvidencePacket["capture_scope"],
): boolean {
  return (
    scope.console !== "session" ||
    scope.network !== "session" ||
    scope.dom === "unavailable" ||
    scope.screenshot !== "current_viewport"
  );
}

function safeTimestamp(timestamp: string): string {
  return timestamp
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
