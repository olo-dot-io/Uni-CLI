/**
 * @owner   src/commands/browser/actions.ts
 * @does    Register browser action, cross-tab content-search, and foreground agent-presence CLI handlers and wrap actions with broker invocation identity, evidence, and target guards.
 * @needs   commander, chalk, fs/path, src/browser observe/snapshot/runtime broker, ./runtime, ./authoring, src/engine/browser
 * @feeds   src/commands/browser/index.ts, src/commands/operate.ts, tests/unit/commands/browser.test.ts
 * @breaks  Action, lease, broker/provider, and evidence failures propagate as command errors or evidence envelopes. No fallback.
 * @invariants Every page mutation executes through BrowserBrokerPage under one explicit invocation identity and target lease; provider-wide search carries the same identity but allocates no target; visible presence requires an explicit foreground scope.
 * @side-effects Navigates pages, mutates browser targets, reads/writes evidence files, and may print operator output.
 * @perf     Action latency is dominated by broker IPC and provider work; state reads avoid allocating additional targets.
 * @concurrency The broker serializes commands per target while distinct Agent sessions may run concurrently.
 * @test     tests/unit/commands/browser.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability experimental
 * @since    2026-04-24
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  basename as pathBasename,
  dirname as pathDirname,
  join,
} from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { userHome } from "../../engine/user-home.js";
import {
  FINGERPRINT_PERSIST_JS,
  verifyRef,
} from "../../browser/snapshot-identity.js";
import { rankCandidates, type SnapshotRef } from "../../browser/observe.js";
import {
  buildExtractJs,
  buildFindJs,
  ensureNetworkCapture,
  getOperatorPage,
  operatorAction,
  readFrames,
  resolveAllowedUploadPath,
  resolveWorkspace,
  validateRef,
  withBrowserOperatorContext,
} from "./runtime.js";
import { ensureBrowserRuntimeBroker } from "../../browser/runtime-launch.js";
import { registerBrowserAuthoringSubcommands } from "./authoring.js";
import {
  captureBrowserEvidencePacket,
  captureRenderAwareBrowserEvidence,
  installBrowserEvidenceHooks,
  readBrowserConsole,
} from "../../engine/browser/evidence.js";
import {
  assertBrowserSessionLeaseUrlGuard,
  createBrowserSessionLease,
} from "../../engine/browser/session-lease.js";
import {
  assertBrowserSessionLeaseTargetCurrent,
  enrichBrowserSessionLease,
} from "../../engine/browser/session-runtime.js";
import {
  type BrowserActionWatchdogMode,
  type BrowserActionWatchdogOptions,
  isBrowserActionEvidenceEnabled,
  withBrowserActionEvidence,
} from "../../engine/browser/action-evidence.js";
import type { NetworkRequest } from "../../types.js";

export { withBrowserOperatorContext };

interface BrowserProgramOptions {
  record?: boolean;
  yes?: boolean;
  permissionProfile?: string;
}
type BrowserDomQueryKind = "text" | "value" | "attributes";

const BROWSER_DOM_QUERY_RESULT_MAX_CHARS = 20_000;

interface BrowserConnectionTargetEvidence {
  readonly source: "cdp_network_response";
  readonly url: string;
  readonly remote_ip_address: string;
  readonly remote_port?: number;
  readonly status: number;
  readonly resource_type: string;
}

export function applyBrowserOperatorRootOptions(command: Command): void {
  command
    .option(
      "--workspace <name>",
      "Use a named profile partition for shared login/storage state",
    )
    .option("--session <id>", "Stable Agent session id for target reuse")
    .option("--turn <id>", "Explicit Agent turn id")
    .option(
      "--provider <provider>",
      "Browser provider: managed, chrome, or remote",
    )
    .option(
      "--visibility <mode>",
      "Visibility contract: hidden, background, or foreground",
    )
    .option("--profile-partition <id>", "Explicit login/storage partition id")
    .option(
      "--profile-id <id>",
      "Seed the managed provider from a discovered local browser profile",
    )
    .option(
      "--ephemeral",
      "Use an intentionally empty temporary managed-browser profile",
    )
    .option(
      "--isolated",
      "Use a disposable managed-browser context inside the selected profile partition",
    )
    .option(
      "--expect-domain <domain>",
      "Require browser commands to run on this hostname or subdomain",
    )
    .option(
      "--expect-path-prefix <prefix>",
      "Require browser commands to run under this URL path prefix",
    )
    .option(
      "--focus",
      "Select the Chrome provider with explicit foreground visibility",
    )
    .option(
      "--background",
      "Select the Chrome provider with a verified non-activating background contract",
    );
}

async function withRecordedBrowserAction<T>(
  program: Command,
  root: Command,
  namespace: "browser" | "operate",
  action: string,
  page: Awaited<ReturnType<typeof getOperatorPage>>,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const programOpts = program.opts() as BrowserProgramOptions;
  const enabled = isBrowserActionEvidenceEnabled(
    programOpts.record === true ? true : undefined,
  );
  if (enabled) {
    await ensureNetworkCapture(page);
  }
  const workspace = resolveWorkspace(root, namespace);
  const lease = await browserSessionLease(root, namespace, workspace, page);
  await assertBrowserSessionLeaseTargetCurrent(lease, page);
  return await withBrowserActionEvidence(
    page,
    {
      command: `${namespace}.${action.split(" ").join("_")}`,
      namespace,
      action,
      workspace,
      lease,
      args,
      enabled,
      approved: programOpts.yes === true,
      permissionProfile: programOpts.permissionProfile,
      watchdog: browserActionWatchdog(action),
    },
    fn,
  );
}

async function browserSessionLease(
  root: Command,
  namespace: "browser" | "operate",
  workspace: string,
  page: Awaited<ReturnType<typeof getOperatorPage>>,
) {
  const rootOpts = root.opts() as {
    isolated?: boolean;
    expectDomain?: string;
    expectPathPrefix?: string;
  };
  const lease = createBrowserSessionLease({
    namespace,
    workspace,
    isolated: rootOpts.isolated,
    expectedDomain: rootOpts.expectDomain,
    expectedPathPrefix: rootOpts.expectPathPrefix,
  });
  assertBrowserSessionLeaseUrlGuard(lease, await page.url());
  return await enrichBrowserSessionLease(lease, page);
}

function browserActionWatchdog(
  action: string,
): BrowserActionWatchdogOptions | undefined {
  if (action !== "click" && action !== "type") return undefined;
  return {
    mode: browserActionWatchdogMode(process.env.UNICLI_BROWSER_WATCHDOG),
    expectMovement: true,
  };
}

function browserActionWatchdogMode(value?: string): BrowserActionWatchdogMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "1":
    case "true":
    case "error":
    case "strict":
      return "error";
    case "warn":
    case "warning":
      return "warn";
    default:
      return "off";
  }
}

async function readBrowserConnectionTargetEvidence(
  page: Awaited<ReturnType<typeof getOperatorPage>>,
  finalUrl: string,
): Promise<BrowserConnectionTargetEvidence | undefined> {
  const requests = await page.networkRequests();
  return selectBrowserConnectionTargetEvidence(finalUrl, requests);
}

function selectBrowserConnectionTargetEvidence(
  finalUrl: string,
  requests: readonly NetworkRequest[],
): BrowserConnectionTargetEvidence | undefined {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (!request?.remoteIPAddress) continue;
    if (!isSameBrowserDocumentUrl(finalUrl, request.url)) continue;
    return {
      source: "cdp_network_response",
      url: request.url,
      remote_ip_address: request.remoteIPAddress,
      ...(request.remotePort !== undefined
        ? { remote_port: request.remotePort }
        : {}),
      status: request.status,
      resource_type: request.type,
    };
  }
  return undefined;
}

function isSameBrowserDocumentUrl(left: string, right: string): boolean {
  if (left === right) return true;
  const normalizedLeft = normalizeBrowserUrlForDocumentMatch(left);
  const normalizedRight = normalizeBrowserUrlForDocumentMatch(right);
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function normalizeBrowserUrlForDocumentMatch(
  rawUrl: string,
): string | undefined {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

interface BrowserCloseAllSessionResult {
  readonly agent_session_id: string;
  readonly action: "ended_session";
  readonly target_count: number;
  readonly status: "completed";
}

interface BrowserCloseAllResult {
  readonly ok: true;
  readonly scope: "all_broker_sessions";
  readonly session_count: number;
  readonly ended_count: number;
  readonly failed_count: 0;
  readonly sessions: readonly BrowserCloseAllSessionResult[];
}

const BROWSER_CDP_READ_ONLY_METHODS = new Set([
  "Page.getFrameTree",
  "Target.getTargetInfo",
]);
const BROWSER_CDP_RESULT_MAX_CHARS = 20_000;

interface BrowserCdpReadOnlyResult {
  readonly ok: true;
  readonly evidence_type: "browser-cdp-readonly";
  readonly workspace: string;
  readonly method: string;
  readonly authority: "read_only_allowlist";
  readonly params_keys: readonly string[];
  readonly result_json_chars: number;
  readonly result_truncated: boolean;
  readonly result?: unknown;
  readonly result_preview?: string;
}

type BrowserDialogAction = "accept" | "dismiss";

interface BrowserDialogProviderEntry {
  readonly id: string;
  readonly type: string;
  readonly message: string;
  readonly opened_at: string;
  readonly url?: string;
  readonly default_prompt?: string;
}

interface BrowserDialogProviderRecord extends BrowserDialogProviderEntry {
  readonly closed_at: string;
  readonly closed_by: "agent" | "remote" | "tab_closed";
  readonly action?: BrowserDialogAction;
}

interface BrowserDialogProviderResult {
  readonly ok: true;
  readonly evidence_type: "browser-dialog-supervision";
  readonly workspace: string;
  readonly captured_at: string;
  readonly supervision: "active";
  readonly pending_count: number;
  readonly recent_count: number;
  readonly pending_dialogs: readonly BrowserDialogProviderEntry[];
  readonly recent_dialogs: readonly BrowserDialogProviderRecord[];
  readonly responded_dialog?: BrowserDialogProviderEntry;
  readonly url?: string;
  readonly title?: string;
}

interface BrowserDownloadProviderEntry {
  readonly id: number;
  readonly state: string;
  readonly danger: string;
  readonly exists: boolean;
  readonly paused: boolean;
  readonly incognito: boolean;
  readonly bytes_received: number;
  readonly total_bytes: number;
  readonly file_size: number;
  readonly filename_basename: string;
  readonly mime?: string;
  readonly url?: string;
  readonly final_url?: string;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly error?: string;
}

interface BrowserDownloadsProviderResult {
  readonly ok: true;
  readonly evidence_type: "browser-downloads";
  readonly workspace: string;
  readonly captured_at: string;
  readonly limit: number;
  readonly count: number;
  readonly downloads: readonly BrowserDownloadProviderEntry[];
}

interface BrowserDomQueryResult {
  readonly ok: true;
  readonly evidence_type: "browser-dom-query";
  readonly authority: "ref_read_only";
  readonly kind: BrowserDomQueryKind;
  readonly ref: string;
  readonly result: string;
  readonly result_chars: number;
  readonly result_truncated: boolean;
  readonly url: string;
}

async function closeAllBrowserSessions(): Promise<BrowserCloseAllResult> {
  const { client, status } = await ensureBrowserRuntimeBroker();
  const sessions = status.sessions.sessions;
  const reports: BrowserCloseAllSessionResult[] = [];

  for (const session of sessions) {
    await client.requestOrThrow({
      id: randomUUID(),
      action: "session.end",
      agent_session_id: session.agent_session_id,
    });
    reports.push({
      agent_session_id: session.agent_session_id,
      action: "ended_session",
      target_count: session.target_ids.length,
      status: "completed",
    });
  }

  return {
    ok: true,
    scope: "all_broker_sessions",
    session_count: sessions.length,
    ended_count: reports.length,
    failed_count: 0,
    sessions: reports,
  };
}

function normalizeBrowserDialogProviderResult(
  result: unknown,
  workspace: string,
): BrowserDialogProviderResult {
  if (
    !isRecord(result) ||
    result.evidence_type !== "browser-dialog-supervision" ||
    result.supervision !== "active"
  ) {
    throw new Error("Browser dialog supervisor returned an invalid payload.");
  }
  const respondedDialog = readDialogEntries([result.responded_dialog])[0];
  return {
    ok: true,
    evidence_type: "browser-dialog-supervision",
    workspace,
    captured_at: readString(result.captured_at) ?? new Date().toISOString(),
    supervision: "active",
    pending_count: readNonNegativeInteger(result.pending_count),
    recent_count: readNonNegativeInteger(result.recent_count),
    pending_dialogs: readDialogEntries(result.pending_dialogs),
    recent_dialogs: readDialogRecords(result.recent_dialogs),
    ...(respondedDialog === undefined
      ? {}
      : { responded_dialog: respondedDialog }),
    ...(readString(result.url) === undefined
      ? {}
      : { url: readString(result.url)! }),
    ...(readString(result.title) === undefined
      ? {}
      : { title: readString(result.title)! }),
  };
}

function normalizeBrowserDownloadsProviderResult(
  result: unknown,
  workspace: string,
  limit: number,
): BrowserDownloadsProviderResult {
  if (!isRecord(result) || result.evidence_type !== "browser-downloads") {
    throw new Error("Browser downloads provider returned an invalid payload.");
  }
  const downloads = readDownloadEntries(result.downloads);
  return {
    ok: true,
    evidence_type: "browser-downloads",
    workspace,
    captured_at: readString(result.captured_at) ?? new Date().toISOString(),
    limit,
    count: downloads.length,
    downloads,
  };
}

function parseBrowserDialogAction(action: string): BrowserDialogAction {
  if (action === "accept" || action === "dismiss") return action;
  throw new Error("Browser dialog action must be accept or dismiss.");
}

function parseBrowserDomQueryKind(
  rawKind: string | undefined,
): BrowserDomQueryKind {
  if (rawKind === undefined || rawKind === "text") return "text";
  if (rawKind === "value" || rawKind === "attributes") return rawKind;
  throw new Error("Browser query kind must be text, value, or attributes.");
}

function buildBrowserDomQueryJs(
  ref: string,
  kind: BrowserDomQueryKind,
): string {
  const refJson = JSON.stringify(ref);
  const kindJson = JSON.stringify(kind);
  return `(() => {
    const __unicli_dom_query = true;
    const ref = ${refJson};
    const kind = ${kindJson};
    const el = document.querySelector('[data-unicli-ref="' + ref + '"]');
    if (!el) throw new Error('Ref not found: ' + ref);
    const readText = () => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return String(el.value || '');
      }
      const text = 'innerText' in el ? el.innerText : el.textContent;
      return String(text || '').trim();
    };
    if (kind === 'text') {
      const value = readText();
      return { value, original_length: value.length, truncated: false };
    }
    if (kind === 'value') {
      const value = 'value' in el ? String(el.value || '') : String(el.getAttribute('value') || '');
      return { value, original_length: value.length, truncated: false };
    }
    const allowed = new Set(['href', 'src', 'alt', 'title', 'aria-label', 'role', 'name', 'placeholder', 'type']);
    const attrs = {};
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (name === 'data-unicli-ref') continue;
      if (!allowed.has(name) && !name.startsWith('aria-')) continue;
      attrs[name] = String(attr.value || '').slice(0, 500);
    }
    const value = JSON.stringify(attrs);
    return { value, original_length: value.length, truncated: false };
  })()`;
}

function normalizeBrowserDomQueryResult({
  kind,
  rawResult,
  ref,
  url,
}: {
  readonly kind: BrowserDomQueryKind;
  readonly rawResult: unknown;
  readonly ref: string;
  readonly url: string;
}): BrowserDomQueryResult {
  if (!isRecord(rawResult)) {
    throw new Error("Browser query provider returned an invalid payload.");
  }
  const value = readStringAllowEmpty(rawResult.value);
  if (value === undefined) {
    throw new Error("Browser query provider returned no result value.");
  }
  const originalLength =
    readNonNegativeInteger(rawResult.original_length) || value.length;
  const truncatedValue =
    value.length <= BROWSER_DOM_QUERY_RESULT_MAX_CHARS
      ? value
      : value.slice(0, BROWSER_DOM_QUERY_RESULT_MAX_CHARS);
  return {
    ok: true,
    evidence_type: "browser-dom-query",
    authority: "ref_read_only",
    kind,
    ref,
    result: truncatedValue,
    result_chars: Math.max(originalLength, value.length),
    result_truncated:
      rawResult.truncated === true ||
      value.length > BROWSER_DOM_QUERY_RESULT_MAX_CHARS,
    url,
  };
}

function readDialogEntries(value: unknown): BrowserDialogProviderEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = readString(entry.id);
    const type = readString(entry.type);
    const message = readString(entry.message);
    const openedAt = readString(entry.opened_at);
    if (
      id === undefined ||
      type === undefined ||
      message === undefined ||
      openedAt === undefined
    ) {
      return [];
    }
    const url = readString(entry.url);
    const defaultPrompt = readString(entry.default_prompt);
    return [
      {
        id: id.slice(0, 120),
        type: type.slice(0, 40),
        message: message.slice(0, 1_000),
        opened_at: openedAt,
        ...(url === undefined ? {} : { url: url.slice(0, 2_000) }),
        ...(defaultPrompt === undefined
          ? {}
          : { default_prompt: defaultPrompt.slice(0, 1_000) }),
      },
    ];
  });
}

function readDialogRecords(value: unknown): BrowserDialogProviderRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((record) => {
    if (!isRecord(record)) return [];
    const entry = readDialogEntries([record])[0];
    const closedAt = readString(record.closed_at);
    const closedBy = readString(record.closed_by);
    if (
      entry === undefined ||
      closedAt === undefined ||
      (closedBy !== "agent" &&
        closedBy !== "remote" &&
        closedBy !== "tab_closed")
    ) {
      return [];
    }
    return [
      {
        ...entry,
        closed_at: closedAt,
        closed_by: closedBy,
        ...(record.action === "accept" || record.action === "dismiss"
          ? { action: record.action }
          : {}),
      },
    ];
  });
}

function readDownloadEntries(value: unknown): BrowserDownloadProviderEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = readNonNegativeInteger(entry.id);
    const state = readString(entry.state);
    const danger = readString(entry.danger);
    const filenameBasename = readString(entry.filename_basename);
    if (
      state === undefined ||
      danger === undefined ||
      filenameBasename === undefined
    ) {
      return [];
    }
    return [
      {
        id,
        state: state.slice(0, 40),
        danger: danger.slice(0, 80),
        exists: entry.exists === true,
        paused: entry.paused === true,
        incognito: entry.incognito === true,
        bytes_received: readNonNegativeInteger(entry.bytes_received),
        total_bytes: readNonNegativeInteger(entry.total_bytes),
        file_size: readNonNegativeInteger(entry.file_size),
        filename_basename: pathBasename(filenameBasename).slice(0, 240),
        ...(readString(entry.mime) === undefined
          ? {}
          : { mime: readString(entry.mime)!.slice(0, 160) }),
        ...(readString(entry.url) === undefined
          ? {}
          : { url: readString(entry.url)!.slice(0, 2_000) }),
        ...(readString(entry.final_url) === undefined
          ? {}
          : { final_url: readString(entry.final_url)!.slice(0, 2_000) }),
        ...(readString(entry.started_at) === undefined
          ? {}
          : { started_at: readString(entry.started_at)! }),
        ...(readString(entry.ended_at) === undefined
          ? {}
          : { ended_at: readString(entry.ended_at)! }),
        ...(readString(entry.error) === undefined
          ? {}
          : { error: readString(entry.error)!.slice(0, 160) }),
      },
    ];
  });
}

function parseDownloadLimit(rawLimit: string | undefined): number {
  const parsed = Number.parseInt(rawLimit ?? "20", 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(1, Math.min(50, Math.trunc(parsed)));
}

function parseBoundedCliInteger(
  raw: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label} must be from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function parseHistoryTimestamp(
  raw: string | undefined,
  label: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const numeric = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const value = Number.isSafeInteger(numeric) ? numeric : Date.parse(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be an ISO date or epoch milliseconds`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringAllowEmpty(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBrowserCdpParams(
  rawParams: string | undefined,
): Record<string, unknown> {
  if (rawParams === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawParams) as unknown;
  } catch {
    throw new Error("CDP params must be a JSON object.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CDP params must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function assertBrowserCdpReadOnlyMethod(method: string): void {
  if (BROWSER_CDP_READ_ONLY_METHODS.has(method)) return;
  throw new Error(
    `CDP method ${method} is not in the read-only allowlist. Supported methods: ${[
      ...BROWSER_CDP_READ_ONLY_METHODS,
    ].join(", ")}`,
  );
}

function createBrowserCdpReadOnlyResult(input: {
  readonly workspace: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly result: unknown;
}): BrowserCdpReadOnlyResult {
  const resultJson = JSON.stringify(input.result ?? null);
  if (resultJson.length <= BROWSER_CDP_RESULT_MAX_CHARS) {
    return {
      ok: true,
      evidence_type: "browser-cdp-readonly",
      workspace: input.workspace,
      method: input.method,
      authority: "read_only_allowlist",
      params_keys: Object.keys(input.params).sort(),
      result_json_chars: resultJson.length,
      result_truncated: false,
      result: input.result,
    };
  }
  return {
    ok: true,
    evidence_type: "browser-cdp-readonly",
    workspace: input.workspace,
    method: input.method,
    authority: "read_only_allowlist",
    params_keys: Object.keys(input.params).sort(),
    result_json_chars: resultJson.length,
    result_truncated: true,
    result_preview: resultJson.slice(0, BROWSER_CDP_RESULT_MAX_CHARS),
  };
}

export function registerBrowserOperatorSubcommands(
  root: Command,
  program: Command,
  namespace: "browser" | "operate",
): void {
  root
    .command("open <url>")
    .description("Navigate one broker-owned browser target to a URL")
    .action((url: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "open",
        async () => {
          const page = await getOperatorPage(root, namespace);
          await ensureNetworkCapture(page);
          await page.goto(url, { settleMs: 2000 });
          const finalUrl = await page.url();
          const [title, connectionTargetEvidence] = await Promise.all([
            page.title(),
            readBrowserConnectionTargetEvidence(page, finalUrl),
          ]);
          return {
            ok: true,
            requested_url: url,
            url: finalUrl,
            title,
            workspace: resolveWorkspace(root, namespace),
            ...(connectionTargetEvidence
              ? { connection_target_evidence: connectionTargetEvidence }
              : {}),
          };
        },
        { url },
      ),
    );

  root
    .command("back")
    .description("Navigate back in history")
    .action(() =>
      operatorAction(program, root, namespace, "back", async () => {
        const page = await getOperatorPage(root, namespace);
        await page.evaluate("history.back()");
        await page.wait(2);
        return { ok: true, url: await page.url() };
      }),
    );

  root
    .command("state")
    .description("Get DOM accessibility tree snapshot")
    .option("--interactive", "only show interactive elements")
    .option("--compact", "omit decorative nodes")
    .action((opts: { interactive?: boolean; compact?: boolean }) =>
      operatorAction(
        program,
        root,
        namespace,
        "state",
        async () => {
          const page = await getOperatorPage(root, namespace);
          return await withRecordedBrowserAction(
            program,
            root,
            namespace,
            "state",
            page,
            {
              interactive: opts.interactive === true,
              compact: opts.compact === true,
            },
            async () => {
              const url = await page.url();
              const snapshot = await page.snapshot({
                interactive: opts.interactive,
                compact: opts.compact,
              });
              console.error(chalk.dim(`URL: ${url}`));
              return { url, snapshot };
            },
          );
        },
        {
          interactive: opts.interactive === true,
          compact: opts.compact === true,
        },
      ),
    );

  root
    .command("query <ref>")
    .description("Read bounded DOM data from a verified snapshot ref")
    .option("--kind <kind>", "Query kind: text, value, or attributes", "text")
    .action((ref: string, opts: { kind?: string }) =>
      operatorAction(
        program,
        root,
        namespace,
        "query",
        async () => {
          validateRef(ref);
          const kind = parseBrowserDomQueryKind(opts.kind);
          const page = await getOperatorPage(root, namespace);
          const selector = `[data-unicli-ref="${ref}"]`;
          return await withRecordedBrowserAction(
            program,
            root,
            namespace,
            "query",
            page,
            { ref, kind },
            async () => {
              await verifyRef(page, selector);
              const url = await page.url();
              const rawResult = await page.evaluate(
                buildBrowserDomQueryJs(ref, kind),
              );
              return normalizeBrowserDomQueryResult({
                kind,
                rawResult,
                ref,
                url,
              });
            },
          );
        },
        { ref, kind: opts.kind ?? "text" },
      ),
    );

  root
    .command("screenshot [path]")
    .description("Capture page screenshot")
    .option("--full-page", "capture full scrollable page")
    .action((path: string | undefined, opts: { fullPage?: boolean }) =>
      operatorAction(
        program,
        root,
        namespace,
        "screenshot",
        async () => {
          const page = await getOperatorPage(root, namespace);
          const buf = await page.screenshot({
            fullPage: opts.fullPage,
            path: path ?? undefined,
          });
          if (path) {
            return { ok: true, path, size: buf.length };
          }
          return buf.toString("base64");
        },
        { path: path ?? null, fullPage: opts.fullPage === true },
      ),
    );

  root
    .command("evidence")
    .description("Capture a browser operator evidence packet")
    .option(
      "--screenshot-dir <path>",
      "Directory for screenshot evidence artifacts",
    )
    .option("--no-screenshot", "Skip screenshot evidence artifact")
    .option(
      "--render-aware",
      "Wait for rendered page evidence to stabilize before returning",
    )
    .option(
      "--stability-ms <n>",
      "Rendered-state stability window for --render-aware",
      "500",
    )
    .option(
      "--timeout-ms <n>",
      "Rendered-state timeout for --render-aware",
      "3000",
    )
    .option(
      "--poll-ms <n>",
      "Rendered-state poll interval for --render-aware",
      "100",
    )
    .action(
      (opts: {
        screenshotDir?: string;
        screenshot?: boolean;
        renderAware?: boolean;
        stabilityMs: string;
        timeoutMs: string;
        pollMs: string;
      }) =>
        operatorAction(
          program,
          root,
          namespace,
          "evidence",
          async () => {
            const page = await getOperatorPage(root, namespace);
            await ensureNetworkCapture(page);
            await installBrowserEvidenceHooks(page);
            const workspace = resolveWorkspace(root, namespace);
            const lease = await browserSessionLease(
              root,
              namespace,
              workspace,
              page,
            );
            const screenshotDir =
              opts.screenshot === false
                ? undefined
                : (opts.screenshotDir ??
                  join(userHome(), ".unicli", "evidence", "browser"));
            if (opts.renderAware) {
              const observation = await captureRenderAwareBrowserEvidence(
                page,
                {
                  action: "evidence",
                  workspace,
                  lease,
                  screenshotDir,
                  stableForMs: parseInt(opts.stabilityMs, 10),
                  timeoutMs: parseInt(opts.timeoutMs, 10),
                  pollMs: parseInt(opts.pollMs, 10),
                },
              );
              return {
                ...observation.packet,
                render_stability: observation.stability,
              };
            }
            return await captureBrowserEvidencePacket(page, {
              action: "evidence",
              workspace,
              lease,
              screenshotDir,
            });
          },
          {
            screenshotDir: opts.screenshotDir ?? null,
            screenshot: opts.screenshot !== false,
            renderAware: opts.renderAware === true,
            stabilityMs: parseInt(opts.stabilityMs, 10),
            timeoutMs: parseInt(opts.timeoutMs, 10),
            pollMs: parseInt(opts.pollMs, 10),
          },
        ),
    );

  root
    .command("console")
    .description("Read bounded browser console messages and page errors")
    .option("--clear", "Clear captured console entries after reading")
    .option("--max <n>", "Maximum console entries to return", "50")
    .option("--text-max <n>", "Maximum text characters per entry", "1000")
    .action((opts: { clear?: boolean; max: string; textMax: string }) =>
      operatorAction(
        program,
        root,
        namespace,
        "console",
        async () => {
          const page = await getOperatorPage(root, namespace);
          return await readBrowserConsole(page, {
            clear: opts.clear === true,
            maxEntries: parseInt(opts.max, 10),
            maxTextChars: parseInt(opts.textMax, 10),
          });
        },
        {
          clear: opts.clear === true,
          max: parseInt(opts.max, 10),
          textMax: parseInt(opts.textMax, 10),
        },
      ),
    );

  root
    .command("cdp <method> [params]")
    .description("Run a read-only allowlisted Chrome DevTools Protocol command")
    .action((method: string, paramsJson: string | undefined) =>
      operatorAction(
        program,
        root,
        namespace,
        "cdp",
        async () => {
          assertBrowserCdpReadOnlyMethod(method);
          const params = parseBrowserCdpParams(paramsJson);
          const page = await getOperatorPage(root, namespace);
          const result = await page.sendCDP(method, params);
          return createBrowserCdpReadOnlyResult({
            workspace: resolveWorkspace(root, namespace),
            method,
            params,
            result,
          });
        },
        { method, params: paramsJson ?? null },
      ),
    );

  root
    .command("dialogs")
    .description("Start and read provider-owned browser dialog supervision")
    .option("--clear-recent", "Clear recent dialog records after reading")
    .action((opts: { clearRecent?: boolean }) =>
      operatorAction(
        program,
        root,
        namespace,
        "dialogs",
        async () => {
          const workspace = resolveWorkspace(root, namespace);
          const page = await getOperatorPage(root, namespace);
          const result = await page.readDialogs(opts.clearRecent === true);
          return normalizeBrowserDialogProviderResult(result, workspace);
        },
        { clearRecent: opts.clearRecent === true },
      ),
    );

  root
    .command("dialog <action> [dialogId]")
    .description("Respond to a pending browser JavaScript dialog")
    .option("--prompt <text>", "Prompt text for prompt() dialogs")
    .action(
      (
        actionRaw: string,
        dialogId: string | undefined,
        opts: { prompt?: string },
      ) =>
        operatorAction(
          program,
          root,
          namespace,
          "dialog",
          async () => {
            const action = parseBrowserDialogAction(actionRaw);
            const workspace = resolveWorkspace(root, namespace);
            const page = await getOperatorPage(root, namespace);
            const result = await page.respondDialog({
              action,
              ...(dialogId === undefined ? {} : { dialogId }),
              ...(opts.prompt === undefined ? {} : { promptText: opts.prompt }),
            });
            return normalizeBrowserDialogProviderResult(result, workspace);
          },
          {
            action: actionRaw,
            dialogId: dialogId ?? null,
            prompt: opts.prompt ?? null,
          },
        ),
    );

  root
    .command("click <ref>")
    .description("Click element by ref number from state")
    .action((ref: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "click",
        async () => {
          validateRef(ref);
          const page = await getOperatorPage(root, namespace);
          const selector = `[data-unicli-ref="${ref}"]`;
          return await withRecordedBrowserAction(
            program,
            root,
            namespace,
            "click",
            page,
            { ref },
            async () => {
              await page.click(selector);
              return { ok: true, clicked: ref };
            },
          );
        },
        { ref },
      ),
    );

  root
    .command("type <ref> <text>")
    .description("Type text into element by ref number")
    .action((ref: string, text: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "type",
        async () => {
          validateRef(ref);
          const page = await getOperatorPage(root, namespace);
          const selector = `[data-unicli-ref="${ref}"]`;
          return await withRecordedBrowserAction(
            program,
            root,
            namespace,
            "type",
            page,
            { ref, text },
            async () => {
              await page.type(selector, text);
              return { ok: true, ref, text };
            },
          );
        },
        { ref, text },
      ),
    );

  root
    .command("keys <key>")
    .description("Press keyboard key (e.g., Enter, Escape, Control+a)")
    .action((key: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "keys",
        async () => {
          const page = await getOperatorPage(root, namespace);
          if (key.includes("+")) {
            const parts = key.split("+");
            const actualKey = parts.pop()!;
            await page.press(
              actualKey,
              parts.map((modifier) => modifier.toLowerCase()),
            );
          } else {
            await page.press(key);
          }
          return { ok: true, key };
        },
        { key },
      ),
    );

  root
    .command("scroll [direction]")
    .description("Scroll page (down, up, bottom, top)")
    .option("--auto", "auto-scroll to bottom")
    .option("--max <n>", "max scroll iterations for auto", "10")
    .action(
      (direction: string | undefined, opts: { auto?: boolean; max: string }) =>
        operatorAction(
          program,
          root,
          namespace,
          "scroll",
          async () => {
            const page = await getOperatorPage(root, namespace);
            if (opts.auto) {
              await page.autoScroll({
                maxScrolls: parseInt(opts.max, 10),
                delay: 1000,
              });
            } else {
              await page.scroll(
                (direction ?? "down") as "down" | "up" | "bottom" | "top",
              );
            }
            return { ok: true, direction: direction ?? "down" };
          },
          {
            direction: direction ?? "down",
            auto: opts.auto === true,
            max: parseInt(opts.max, 10),
          },
        ),
    );

  const get = root
    .command("get")
    .description("Get page data (title, url, text, value, html, attributes)");

  get
    .command("title")
    .description("Get page title")
    .action(() =>
      operatorAction(program, root, namespace, "get title", async () => {
        const page = await getOperatorPage(root, namespace);
        return await page.title();
      }),
    );

  get
    .command("url")
    .description("Get current URL")
    .action(() =>
      operatorAction(program, root, namespace, "get url", async () => {
        const page = await getOperatorPage(root, namespace);
        const url = await page.url();
        const connectionTargetEvidence =
          await readBrowserConnectionTargetEvidence(page, url);
        return {
          value: url,
          ...(connectionTargetEvidence
            ? { connection_target_evidence: connectionTargetEvidence }
            : {}),
        };
      }),
    );

  get
    .command("text <ref>")
    .description("Get text content of element by ref")
    .action((ref: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "get text",
        async () => {
          validateRef(ref);
          const page = await getOperatorPage(root, namespace);
          return await page.evaluate(
            `document.querySelector('[data-unicli-ref="${ref}"]')?.textContent?.trim() ?? null`,
          );
        },
        { ref },
      ),
    );

  get
    .command("value <ref>")
    .description("Get value of input element by ref")
    .action((ref: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "get value",
        async () => {
          validateRef(ref);
          const page = await getOperatorPage(root, namespace);
          return await page.evaluate(
            `document.querySelector('[data-unicli-ref="${ref}"]')?.value ?? null`,
          );
        },
        { ref },
      ),
    );

  get
    .command("html [selector]")
    .description("Get outerHTML of element (or full page)")
    .action((selector: string | undefined) =>
      operatorAction(
        program,
        root,
        namespace,
        "get html",
        async () => {
          const page = await getOperatorPage(root, namespace);
          if (selector) {
            const selectorStr = JSON.stringify(selector);
            return await page.evaluate(
              `document.querySelector(${selectorStr})?.outerHTML?.slice(0, 50000) ?? null`,
            );
          }
          return await page.evaluate(
            "document.documentElement.outerHTML.slice(0, 50000)",
          );
        },
        { selector: selector ?? null },
      ),
    );

  get
    .command("attributes <ref>")
    .description("Get all attributes of element by ref")
    .action((ref: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "get attributes",
        async () => {
          validateRef(ref);
          const page = await getOperatorPage(root, namespace);
          return await page.evaluate(
            `(() => { const el = document.querySelector('[data-unicli-ref="${ref}"]'); if (!el) return null; const attrs = {}; for (const a of el.attributes) attrs[a.name] = a.value; return attrs; })()`,
          );
        },
        { ref },
      ),
    );

  root
    .command("wait <type> [value]")
    .description("Wait for condition (time <ms>, selector <sel>, text <str>)")
    .option("--timeout <ms>", "timeout in ms", "10000")
    .action(
      (type: string, value: string | undefined, opts: { timeout: string }) =>
        operatorAction(
          program,
          root,
          namespace,
          "wait",
          async () => {
            const page = await getOperatorPage(root, namespace);
            const timeout = parseInt(opts.timeout, 10);
            return await withRecordedBrowserAction(
              program,
              root,
              namespace,
              "wait",
              page,
              { type, value: value ?? null, timeout },
              async () => {
                switch (type) {
                  case "time":
                    await page.wait(parseInt(value ?? "1000", 10) / 1000);
                    break;
                  case "selector":
                    if (!value) throw new Error("selector value required");
                    await page.waitForSelector(value, timeout);
                    break;
                  case "text": {
                    if (!value) throw new Error("text value required");
                    const deadline = Date.now() + timeout;
                    const valueStr = JSON.stringify(value);
                    while (Date.now() < deadline) {
                      const found = await page.evaluate(
                        `document.body.innerText.includes(${valueStr})`,
                      );
                      if (found) return { ok: true, found: true };
                      await new Promise((resolve) => setTimeout(resolve, 200));
                    }
                    throw new Error(
                      `Text "${value}" not found within ${String(timeout)}ms`,
                    );
                  }
                  default:
                    throw new Error(
                      `Unknown wait type: ${type}. Use: time, selector, text`,
                    );
                }
                return { ok: true };
              },
            );
          },
          {
            type,
            value: value ?? null,
            timeout: parseInt(opts.timeout, 10),
          },
        ),
    );

  root
    .command("eval <js>")
    .description("Execute JavaScript in page context")
    .action((js: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "eval",
        async () => {
          const page = await getOperatorPage(root, namespace);
          return await page.evaluate(js);
        },
        { js },
      ),
    );

  registerBrowserAuthoringSubcommands(root, program, namespace);

  root
    .command("select <ref> <option>")
    .description("Select option in dropdown by ref")
    .action((ref: string, option: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "select",
        async () => {
          validateRef(ref);
          const page = await getOperatorPage(root, namespace);
          const optionStr = JSON.stringify(option);
          await page.evaluate(
            `(() => {
            const el = document.querySelector('[data-unicli-ref="${ref}"]');
            if (!el || el.tagName !== 'SELECT') throw new Error('Not a <select> element');
            el.value = ${optionStr};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`,
          );
          return { ok: true, ref, option };
        },
        { ref, option },
      ),
    );

  root
    .command("upload <ref> <path>")
    .description("Upload file to file input element by ref number")
    .action((ref: string, filePath: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "upload",
        async () => {
          validateRef(ref);
          const selector = `[data-unicli-ref="${ref}"]`;
          const absolutePath = resolveAllowedUploadPath(filePath);
          const page = await getOperatorPage(root, namespace);
          await page.setFileInput(selector, [absolutePath]);
          return { ok: true, ref, path: absolutePath };
        },
        { ref, path: filePath },
      ),
    );

  root
    .command("hover <ref>")
    .description("Hover over element by ref number")
    .action((ref: string) =>
      operatorAction(
        program,
        root,
        namespace,
        "hover",
        async () => {
          validateRef(ref);
          const selector = `[data-unicli-ref="${ref}"]`;
          const selectorJson = JSON.stringify(selector);
          const page = await getOperatorPage(root, namespace);
          await page.evaluate(
            `(() => {
            const el = document.querySelector(${selectorJson});
            if (!el) throw new Error('Element not found: ' + ${selectorJson});
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          })()`,
          );
          return { ok: true, ref };
        },
        { ref },
      ),
    );

  root
    .command("observe <query>")
    .description("Preview ranked candidate actions for a natural-language goal")
    .option("--top-k <n>", "Number of candidates to return", "5")
    .option(
      "--cache <path>",
      "Cache file (default ~/.unicli/observe-cache.jsonl)",
    )
    .action((query: string, opts: { topK?: string; cache?: string }) =>
      operatorAction(
        program,
        root,
        namespace,
        "observe",
        async () => {
          const page = await getOperatorPage(root, namespace);
          const rawSnapshot = await page.snapshot({
            interactive: true,
            raw: true,
          });
          let parsed: { refs?: SnapshotRef[] } = { refs: [] };
          if (typeof rawSnapshot === "string") {
            try {
              parsed = JSON.parse(rawSnapshot) as { refs?: SnapshotRef[] };
            } catch {
              // Ignore malformed raw snapshot payloads.
            }
          } else {
            parsed = rawSnapshot as { refs?: SnapshotRef[] };
          }
          const refs = Array.isArray(parsed.refs) ? parsed.refs : [];
          const topK = parseInt(opts.topK ?? "5", 10) || 5;
          const candidates = rankCandidates(refs, query, topK);

          const cachePath =
            opts.cache ?? join(userHome(), ".unicli", "observe-cache.jsonl");
          mkdirSync(pathDirname(cachePath), { recursive: true });
          appendFileSync(
            cachePath,
            JSON.stringify({
              ts: new Date().toISOString(),
              url: await page.url(),
              query,
              candidates,
            }) + "\n",
            "utf-8",
          );

          return { query, candidates };
        },
        {
          query,
          topK: parseInt(opts.topK ?? "5", 10) || 5,
          cache: opts.cache ?? null,
        },
      ),
    );

  root
    .command("find")
    .description("Find elements by CSS selector and allocate refs on demand")
    .requiredOption("--css <selector>", "CSS selector to query")
    .option("--limit <n>", "Maximum matches to return", "20")
    .option("--text-max <n>", "Maximum text length per row", "120")
    .action((opts: { css: string; limit: string; textMax: string }) =>
      operatorAction(
        program,
        root,
        namespace,
        "find",
        async () => {
          const page = await getOperatorPage(root, namespace);
          const results = (await page.evaluate(
            buildFindJs(
              opts.css,
              parseInt(opts.limit, 10) || 20,
              parseInt(opts.textMax, 10) || 120,
            ),
          )) as Array<Record<string, unknown>>;
          try {
            await page.evaluate(FINGERPRINT_PERSIST_JS);
          } catch {
            // Best-effort only.
          }
          return results;
        },
        {
          css: opts.css,
          limit: parseInt(opts.limit, 10) || 20,
          textMax: parseInt(opts.textMax, 10) || 120,
        },
      ),
    );

  root
    .command("frames")
    .description("List iframe frame tree entries for the current page")
    .action(() =>
      operatorAction(program, root, namespace, "frames", async () => {
        const page = await getOperatorPage(root, namespace);
        return await readFrames(page);
      }),
    );

  root
    .command("downloads")
    .description(
      "List recent browser downloads without exposing local file paths",
    )
    .option("--limit <n>", "Maximum download records to return", "20")
    .action((opts: { limit?: string }) =>
      operatorAction(
        program,
        root,
        namespace,
        "downloads",
        async () => {
          const workspace = resolveWorkspace(root, namespace);
          const limit = parseDownloadLimit(opts.limit);
          const page = await getOperatorPage(root, namespace);
          const result = await page.readDownloads(limit);
          return normalizeBrowserDownloadsProviderResult(
            result,
            workspace,
            limit,
          );
        },
        { limit: parseDownloadLimit(opts.limit) },
      ),
    );

  root
    .command("extract")
    .description("Extract long-form page text with chunked pagination")
    .option("--selector <css>", "Optional content root selector")
    .option("--chunk-size <n>", "Maximum chars to return", "8000")
    .option("--start <n>", "Start offset", "0")
    .option(
      "--render-aware",
      "Wait for rendered page evidence to stabilize before extracting text",
    )
    .option("--no-screenshot", "Skip screenshot evidence during render wait")
    .option(
      "--stability-ms <n>",
      "Rendered-state stability window for --render-aware",
      "500",
    )
    .option(
      "--timeout-ms <n>",
      "Rendered-state timeout for --render-aware",
      "3000",
    )
    .option(
      "--poll-ms <n>",
      "Rendered-state poll interval for --render-aware",
      "100",
    )
    .action(
      (opts: {
        selector?: string;
        chunkSize: string;
        start: string;
        renderAware?: boolean;
        screenshot?: boolean;
        stabilityMs: string;
        timeoutMs: string;
        pollMs: string;
      }) =>
        operatorAction(
          program,
          root,
          namespace,
          "extract",
          async () => {
            const page = await getOperatorPage(root, namespace);
            let renderStability: Record<string, unknown> | undefined;
            if (opts.renderAware) {
              await ensureNetworkCapture(page);
              await installBrowserEvidenceHooks(page);
              const workspace = resolveWorkspace(root, namespace);
              const lease = await browserSessionLease(
                root,
                namespace,
                workspace,
                page,
              );
              const observation = await captureRenderAwareBrowserEvidence(
                page,
                {
                  action: "extract",
                  workspace,
                  lease,
                  screenshotDir:
                    opts.screenshot === false
                      ? undefined
                      : join(userHome(), ".unicli", "evidence", "browser"),
                  stableForMs: parseInt(opts.stabilityMs, 10),
                  timeoutMs: parseInt(opts.timeoutMs, 10),
                  pollMs: parseInt(opts.pollMs, 10),
                },
              );
              renderStability = observation.stability;
            }
            const result = (await page.evaluate(
              buildExtractJs(opts.selector),
            )) as {
              selector: string;
              title: string;
              url: string;
              content: string;
            };
            const start = Math.max(0, parseInt(opts.start, 10) || 0);
            const chunkSize = Math.max(
              256,
              parseInt(opts.chunkSize, 10) || 8000,
            );
            const end = Math.min(result.content.length, start + chunkSize);
            return {
              url: result.url,
              title: result.title,
              selector: result.selector,
              total_chars: result.content.length,
              chunk_size: chunkSize,
              start,
              end,
              next_start_char: end < result.content.length ? end : null,
              content: result.content.slice(start, end),
              ...(renderStability ? { render_stability: renderStability } : {}),
            };
          },
          {
            selector: opts.selector ?? null,
            chunkSize: parseInt(opts.chunkSize, 10) || 8000,
            start: parseInt(opts.start, 10) || 0,
            renderAware: opts.renderAware === true,
            screenshot: opts.screenshot !== false,
            stabilityMs: parseInt(opts.stabilityMs, 10),
            timeoutMs: parseInt(opts.timeoutMs, 10),
            pollMs: parseInt(opts.pollMs, 10),
          },
        ),
    );

  root
    .command("tabs")
    .description("List tabs for the current browser workspace")
    .action(() =>
      operatorAction(program, root, namespace, "tabs", async () => {
        const page = await getOperatorPage(root, namespace);
        return await page.tabs();
      }),
    );

  root
    .command("search <query>")
    .description(
      "Search bounded content across eligible open Chrome tabs without focus or navigation",
    )
    .option("--history", "Also search Chrome history metadata")
    .option("--from <time>", "History start as ISO date or epoch milliseconds")
    .option("--to <time>", "History end as ISO date or epoch milliseconds")
    .option("--max-results <n>", "Maximum merged results (1-100)")
    .option("--max-tabs <n>", "Maximum recent open tabs to scan (1-200)")
    .option(
      "--max-chars-per-tab <n>",
      "Maximum DOM text characters scanned per tab (1024-500000)",
    )
    .action(
      (
        query: string,
        opts: {
          history?: boolean;
          from?: string;
          to?: string;
          maxResults?: string;
          maxTabs?: string;
          maxCharsPerTab?: string;
        },
      ) => {
        const historyStartTime = parseHistoryTimestamp(opts.from, "--from");
        const historyEndTime = parseHistoryTimestamp(opts.to, "--to");
        const includeHistory =
          opts.history === true ||
          historyStartTime !== undefined ||
          historyEndTime !== undefined;
        const maxResults = parseBoundedCliInteger(
          opts.maxResults,
          "--max-results",
          1,
          100,
        );
        const maxTabs = parseBoundedCliInteger(
          opts.maxTabs,
          "--max-tabs",
          1,
          200,
        );
        const maxCharsPerTab = parseBoundedCliInteger(
          opts.maxCharsPerTab,
          "--max-chars-per-tab",
          1_024,
          500_000,
        );
        const search = {
          query,
          ...(includeHistory ? { include_history: true } : {}),
          ...(maxResults === undefined ? {} : { max_results: maxResults }),
          ...(maxTabs === undefined ? {} : { max_tabs: maxTabs }),
          ...(maxCharsPerTab === undefined
            ? {}
            : { max_chars_per_tab: maxCharsPerTab }),
          ...(historyStartTime === undefined
            ? {}
            : { history_start_time: historyStartTime }),
          ...(historyEndTime === undefined
            ? {}
            : { history_end_time: historyEndTime }),
        };
        return operatorAction(
          program,
          root,
          namespace,
          "search",
          async () => {
            const page = await getOperatorPage(root, namespace);
            return page.searchChromeContent(search);
          },
          search,
          { provider: "chrome", visibility: "background" },
        );
      },
    );

  const agent = root
    .command("agent")
    .description(
      "Render explicit foreground-only Agent presence on the controlled Chrome tab",
    );
  agent
    .command("show")
    .description("Show a steady isolated edge glow; requires --focus")
    .option("--label <text>", "Badge label (1-80 characters)")
    .action((opts: { label?: string }) =>
      operatorAction(
        program,
        root,
        namespace,
        "agent show",
        async () => {
          const page = await getOperatorPage(root, namespace);
          return page.setAgentPresence(true, opts.label);
        },
        { label: opts.label ?? null },
      ),
    );
  agent
    .command("cursor <x> <y>")
    .description(
      "Move the compositor-friendly virtual cursor in CSS pixels; requires --focus and agent show",
    )
    .action((xRaw: string, yRaw: string) => {
      const x = parseBoundedCliInteger(
        xRaw,
        "cursor x",
        0,
        Number.MAX_SAFE_INTEGER,
      )!;
      const y = parseBoundedCliInteger(
        yRaw,
        "cursor y",
        0,
        Number.MAX_SAFE_INTEGER,
      )!;
      return operatorAction(
        program,
        root,
        namespace,
        "agent cursor",
        async () => {
          const page = await getOperatorPage(root, namespace);
          return page.moveAgentCursor(x, y);
        },
        { x, y },
      );
    });
  agent
    .command("hide")
    .description("Remove edge glow and cursor; requires --focus")
    .action(() =>
      operatorAction(program, root, namespace, "agent hide", async () => {
        const page = await getOperatorPage(root, namespace);
        return page.setAgentPresence(false);
      }),
    );

  root
    .command("close")
    .description("Close the automation browser window")
    .option("--all", "Close or release all managed browser sessions")
    .action((opts: { all?: boolean }) =>
      operatorAction(
        program,
        root,
        namespace,
        "close",
        async () => {
          if (opts.all === true) {
            return await closeAllBrowserSessions();
          }
          const page = await getOperatorPage(root, namespace);
          await page.closeWindow();
          return {
            ok: true,
            scope: "current_managed_session",
            workspace: resolveWorkspace(root, namespace),
          };
        },
        { all: opts.all === true },
      ),
    );
}
