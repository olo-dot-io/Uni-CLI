/**
 * @owner   src/commands/browser/runtime.ts
 * @does    Provide shared browser operator invocation identity, provider policy, broker page access, evidence normalization, and output formatting.
 * @needs   commander, browser broker invocation scope, direct operator permission policy, sensitive-path permissions, output
 * @feeds   src/commands/browser/actions.ts, src/commands/browser/authoring.ts
 * @breaks  Bridge, workspace, permission, and formatting failures return structured errors and nonzero exits. No fallback.
 * @invariants One invocation scope owns one immutable Agent/session/turn/provider/visibility/profile-partition identity.
 * @side-effects Acquires broker sessions, runs page commands, formats output, and finalizes invocation-owned resources.
 * @perf     Scope setup performs one broker session acquisition; repeated actions reuse that session target.
 * @concurrency AsyncLocalStorage isolates simultaneous invocation identities within one CLI or MCP process.
 * @test     tests/unit/commands/browser.test.ts, tests/unit/browser-invocation-scope.test.ts
 * @stability experimental
 * @since    2026-04-24
 */

import { isAbsolute, relative, resolve } from "node:path";
import { Command } from "commander";
import { BrowserBridge, type BrowserBrokerPage } from "../../browser/bridge.js";
import { createBrowserInvocationContext } from "../../browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
  type BrowserProvider,
} from "../../browser/invocation-scope.js";
import {
  buildSensitivePathDenial,
  isSensitivePathRealpath,
} from "../../permissions/sensitive-paths.js";
import type { OutputFormat } from "../../types.js";
import { detectFormat, format } from "../../output/formatter.js";
import { makeCtx } from "../../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../../output/error-map.js";
import { userHome } from "../../engine/user-home.js";
import { authorizeBrowserCommand } from "./permission.js";

export interface BrowserOperatorRootOptions {
  workspace?: string;
  session?: string;
  turn?: string;
  provider?: string;
  visibility?: string;
  profilePartition?: string;
  profileId?: string;
  ephemeral?: boolean;
  isolated?: boolean;
  focus?: boolean;
  background?: boolean;
  expectDomain?: string;
  expectPathPrefix?: string;
}

export interface BrowserOperatorContextDefaults {
  provider?: BrowserProvider;
  visibility?: "hidden" | "background" | "foreground";
}

interface ResolvedBrowserOperatorSelection {
  provider: BrowserProvider;
  visibility: "hidden" | "background" | "foreground";
  profilePartitionId: string;
  isolated: boolean;
  ephemeral: boolean;
  profileId?: string;
}

export interface NormalizedNetworkEntry {
  url: string;
  method: string;
  status: number;
  contentType: string;
  bodySize: number;
  body?: unknown;
}

export function validateRef(ref: string): string {
  if (!/^\d+$/.test(ref)) {
    throw new Error(
      `Invalid ref "${ref}". Expected a number from the state output.`,
    );
  }
  return ref;
}

function getRootOpts(root: Command): BrowserOperatorRootOptions {
  return root.opts() as BrowserOperatorRootOptions;
}

export function resolveWorkspace(root: Command, namespace: string): string {
  void namespace;
  const opts = getRootOpts(root);
  const explicit = opts.profilePartition?.trim() || opts.workspace?.trim();
  if (explicit) return explicit;
  return opts.profileId ? `profile:${opts.profileId}` : "default";
}

export function browserOperatorPermissionArguments(
  root: Command,
  argumentValues: Record<string, unknown> = {},
  defaults: BrowserOperatorContextDefaults = {},
): Record<string, unknown> {
  const selection = resolveBrowserOperatorSelection(root, defaults);
  const opts = getRootOpts(root);
  return {
    provider: selection.provider,
    visibility: selection.visibility,
    profilePartitionId: selection.profilePartitionId,
    isolated: selection.isolated,
    ephemeral: selection.ephemeral,
    profileId: selection.profileId ?? null,
    expectDomain: opts.expectDomain ?? null,
    expectPathPrefix: opts.expectPathPrefix ?? null,
    ...argumentValues,
  };
}

export async function withBrowserOperatorContext<T>(
  root: Command,
  fn: () => Promise<T>,
  defaults: BrowserOperatorContextDefaults = {},
): Promise<T> {
  const opts = getRootOpts(root);
  const selection = resolveBrowserOperatorSelection(root, defaults);
  const context = createBrowserInvocationContext({
    transport: "cli",
    agentSessionId: opts.session,
    turnId: opts.turn,
    profilePartitionId: selection.profilePartitionId,
  });
  const scope = createBrowserInvocationScope({
    context,
    ...selection,
  });
  return runBrowserInvocation(scope, fn);
}

function resolveBrowserOperatorSelection(
  root: Command,
  defaults: BrowserOperatorContextDefaults,
): ResolvedBrowserOperatorSelection {
  const opts = getRootOpts(root);
  if (opts.focus && opts.background) {
    throw new Error("--focus and --background cannot be combined");
  }
  const requestedVisibility =
    parseVisibility(opts.visibility) ??
    (opts.focus ? "foreground" : opts.background ? "background" : undefined);
  const provider =
    parseProvider(opts.provider) ??
    defaults.provider ??
    (requestedVisibility === "background" ||
    requestedVisibility === "foreground"
      ? "chrome"
      : "managed");
  const visibility =
    requestedVisibility ??
    defaults.visibility ??
    (provider === "chrome" ? "background" : "hidden");
  return {
    provider,
    visibility,
    profilePartitionId: resolveWorkspace(root, "browser"),
    isolated: opts.isolated === true,
    ephemeral: opts.ephemeral === true,
    ...(opts.profileId ? { profileId: opts.profileId } : {}),
  };
}

function parseProvider(value: string | undefined): BrowserProvider | undefined {
  if (value === undefined) return undefined;
  if (value === "managed" || value === "chrome" || value === "remote") {
    return value;
  }
  throw new Error(
    `Invalid browser provider "${value}"; expected managed, chrome, or remote`,
  );
}

function parseVisibility(
  value: string | undefined,
): "hidden" | "background" | "foreground" | undefined {
  if (value === undefined) return undefined;
  if (value === "hidden" || value === "background" || value === "foreground") {
    return value;
  }
  throw new Error(
    `Invalid browser visibility "${value}"; expected hidden, background, or foreground`,
  );
}

export async function getOperatorPage(
  root: Command,
  namespace: string,
): Promise<BrowserBrokerPage> {
  const bridge = new BrowserBridge();
  const page = await bridge.connect({
    timeout: 30_000,
    workspace: resolveWorkspace(root, namespace),
  });
  return page as BrowserBrokerPage;
}

export async function operatorAction(
  program: Command,
  root: Command,
  namespace: string,
  name: string,
  fn: () => Promise<unknown>,
  argumentValues: Record<string, unknown> = {},
  defaults: BrowserOperatorContextDefaults = {},
): Promise<void> {
  const startedAt = Date.now();
  const ctx = makeCtx(`${namespace}.${name.split(" ").join("_")}`, startedAt);
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);

  try {
    await authorizeBrowserCommand(
      program,
      namespace,
      name,
      browserOperatorPermissionArguments(root, argumentValues, defaults),
    );
    const result = await withBrowserOperatorContext(root, fn, defaults);
    let data: unknown[] | Record<string, unknown>;
    if (result === undefined || result === null) {
      data = { ok: true };
    } else if (typeof result === "string") {
      data = { value: result };
    } else if (Array.isArray(result)) {
      data = result;
    } else if (typeof result === "object") {
      data = result as Record<string, unknown>;
    } else {
      data = { value: String(result) };
    }

    ctx.duration_ms = Date.now() - startedAt;
    console.log(format(data, undefined, fmt, ctx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tagged = err as Partial<{
      code: string;
      suggestion: string;
      exitCode: number;
    }>;
    const code = tagged.code ?? errorTypeToCode(err);
    ctx.error = {
      code,
      message,
      ...(tagged.suggestion ? { suggestion: tagged.suggestion } : {}),
      retryable:
        code === "stale_ref" ||
        code === "browser_lease_locked" ||
        /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|broker failed/i.test(
          message,
        ),
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exitCode = tagged.exitCode ?? mapErrorToExitCode(err);
  }
}

export async function ensureNetworkCapture(
  page: BrowserBrokerPage,
): Promise<void> {
  await page.startNetworkCapture();
}

export async function readNetworkEntries(
  page: BrowserBrokerPage,
): Promise<{ raw: unknown[]; normalized: NormalizedNetworkEntry[] }> {
  const rawEntries = await page.readNetworkCapture();
  if (rawEntries.length > 0) {
    return {
      raw: rawEntries,
      normalized: rawEntries.map((entry) => ({
        url: entry.url,
        method: entry.method,
        status: entry.status,
        contentType: entry.contentType,
        bodySize: entry.size,
        ...(entry.responseBody === undefined
          ? {}
          : { body: entry.responseBody }),
      })),
    };
  }

  const requests = await page.networkRequests();
  return {
    raw: requests,
    normalized: requests.map((request) => ({
      url: request.url,
      method: request.method,
      status: request.status,
      contentType: request.type,
      bodySize: request.size,
    })),
  };
}

export async function readFrames(
  page: BrowserBrokerPage,
): Promise<
  Array<{ index: number; frameId: string; parentFrameId?: string; url: string }>
> {
  const raw = (await page.sendCDP("Page.getFrameTree")) as {
    frameTree?: {
      frame?: { id?: string; parentId?: string; url?: string };
      childFrames?: unknown[];
    };
  };

  const frames: Array<{
    index: number;
    frameId: string;
    parentFrameId?: string;
    url: string;
  }> = [];

  function walk(
    tree: {
      frame?: { id?: string; parentId?: string; url?: string };
      childFrames?: unknown[];
    } | null,
    includeSelf: boolean,
  ): void {
    if (!tree) return;
    if (includeSelf && tree.frame?.id) {
      frames.push({
        index: frames.length,
        frameId: tree.frame.id,
        parentFrameId: tree.frame.parentId,
        url: tree.frame.url ?? "",
      });
    }
    for (const child of tree.childFrames ?? []) {
      walk(
        child as {
          frame?: { id?: string; parentId?: string; url?: string };
          childFrames?: unknown[];
        },
        true,
      );
    }
  }

  walk(raw.frameTree ?? null, false);
  return frames;
}

export function buildFindJs(
  selector: string,
  limit: number,
  textMax: number,
): string {
  const selectorJson = JSON.stringify(selector);
  return `(() => {
    const matches = Array.from(document.querySelectorAll(${selectorJson})).slice(0, ${String(limit)});
    let maxRef = 0;
    for (const node of document.querySelectorAll('[data-unicli-ref]')) {
      const value = parseInt(node.getAttribute('data-unicli-ref') || '0', 10);
      if (!Number.isNaN(value) && value > maxRef) maxRef = value;
    }
    return matches.map((el, index) => {
      let ref = el.getAttribute('data-unicli-ref');
      if (!ref) {
        ref = String(++maxRef);
        el.setAttribute('data-unicli-ref', ref);
      }
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0;
      const attrs = {};
      for (const name of ['id', 'name', 'type', 'href', 'src', 'placeholder', 'role', 'aria-label', 'data-testid']) {
        const value = el.getAttribute(name);
        if (value) attrs[name] = value;
      }
      return {
        nth: index,
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, ${String(textMax)}),
        visible,
        attrs,
      };
    });
  })()`;
}

export function buildExtractJs(selector?: string): string {
  const selectorJson =
    selector && selector.trim() ? JSON.stringify(selector.trim()) : "null";
  return `(() => {
    const picks = [];
    const explicit = ${selectorJson};
    if (explicit) picks.push(explicit);
    picks.push('main', 'article', '[role="main"]', 'body');
    let target = null;
    let resolved = 'body';
    for (const pick of picks) {
      const node = document.querySelector(pick);
      if (node) {
        target = node;
        resolved = pick;
        break;
      }
    }
    const text = (target?.innerText || document.body?.innerText || '').replace(/\\u00a0/g, ' ').trim();
    return {
      selector: resolved,
      title: document.title || '',
      url: location.href,
      content: text,
    };
  })()`;
}

function isSameOrDescendantPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveAllowedUploadPath(filePath: string): string {
  const absolutePath = resolve(filePath);
  if (isSensitivePathRealpath(absolutePath)) {
    const denial = buildSensitivePathDenial(absolutePath);
    const err = new Error("upload blocked by sensitive-path guard") as Error & {
      code?: string;
      suggestion?: string;
    };
    err.code = "permission_denied";
    err.suggestion = denial.hint;
    throw err;
  }

  const cwd = process.cwd();
  const home = userHome();
  if (
    !isSameOrDescendantPath(cwd, absolutePath) &&
    !isSameOrDescendantPath(home, absolutePath)
  ) {
    const err = new Error(
      `upload blocked: path ${absolutePath} is outside workspace and home directory`,
    ) as Error & { code?: string; suggestion?: string };
    err.code = "permission_denied";
    err.suggestion =
      "Copy the file under the current working directory or $HOME before uploading.";
    throw err;
  }

  return absolutePath;
}
