import { isAbsolute, relative, resolve } from "node:path";
import { Command } from "commander";
import { BrowserBridge, type DaemonPage } from "../browser/bridge.js";
import { resolveBrowserWorkspace } from "../browser/workspace.js";
import {
  generateInterceptorJs,
  generateReadInterceptedJs,
} from "../engine/interceptor.js";
import {
  buildSensitivePathDenial,
  isSensitivePathRealpath,
} from "../permissions/sensitive-paths.js";
import type { OutputFormat } from "../types.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";
import { userHome } from "../engine/user-home.js";

export interface BrowserOperatorRootOptions {
  workspace?: string;
  isolated?: boolean;
  sharedSession?: boolean;
  daemonPort?: string;
  focus?: boolean;
  background?: boolean;
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
  const opts = getRootOpts(root);
  return resolveBrowserWorkspace(namespace, {
    workspace: opts.workspace,
    isolated: opts.isolated,
    sharedSession: opts.sharedSession,
  });
}

export async function withBrowserOperatorEnv<T>(
  root: Command,
  fn: () => Promise<T>,
): Promise<T> {
  const opts = getRootOpts(root);
  const prevPort = process.env.UNICLI_DAEMON_PORT;
  const prevFocus = process.env.UNICLI_WINDOW_FOCUSED;

  if (opts.daemonPort) {
    process.env.UNICLI_DAEMON_PORT = opts.daemonPort;
  }
  if (opts.focus) {
    process.env.UNICLI_WINDOW_FOCUSED = "1";
  } else if (opts.background) {
    process.env.UNICLI_WINDOW_FOCUSED = "0";
  }

  try {
    return await fn();
  } finally {
    if (opts.daemonPort) {
      if (prevPort === undefined) delete process.env.UNICLI_DAEMON_PORT;
      else process.env.UNICLI_DAEMON_PORT = prevPort;
    }
    if (opts.focus || opts.background) {
      if (prevFocus === undefined) delete process.env.UNICLI_WINDOW_FOCUSED;
      else process.env.UNICLI_WINDOW_FOCUSED = prevFocus;
    }
  }
}

export async function getOperatorPage(
  root: Command,
  namespace: string,
): Promise<DaemonPage> {
  const bridge = new BrowserBridge();
  const page = await bridge.connect({
    timeout: 30_000,
    workspace: resolveWorkspace(root, namespace),
  });
  return page as DaemonPage;
}

export async function operatorAction(
  program: Command,
  root: Command,
  namespace: string,
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  const startedAt = Date.now();
  const ctx = makeCtx(`${namespace}.${name.split(" ").join("_")}`, startedAt);
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);

  try {
    const result = await withBrowserOperatorEnv(root, fn);
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
    const tagged = err as Partial<{ code: string; suggestion: string }>;
    const code = tagged.code ?? errorTypeToCode(err);
    ctx.error = {
      code,
      message,
      ...(tagged.suggestion ? { suggestion: tagged.suggestion } : {}),
      retryable:
        code === "stale_ref" ||
        /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|daemon failed/i.test(
          message,
        ),
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, fmt, ctx));
    process.exitCode = mapErrorToExitCode(err);
  }
}

export async function ensureNetworkCapture(page: DaemonPage): Promise<void> {
  const pageAny = page as unknown as {
    startNetworkCapture?: () => Promise<boolean | void>;
  };
  let captureStarted = false;
  if (typeof pageAny.startNetworkCapture === "function") {
    captureStarted = (await pageAny.startNetworkCapture()) !== false;
  }
  if (!captureStarted) {
    try {
      await page.evaluate(generateInterceptorJs("", { captureText: true }));
    } catch {
      // Best effort only.
    }
  }
}

export async function readNetworkEntries(
  page: DaemonPage,
): Promise<{ raw: unknown[]; normalized: NormalizedNetworkEntry[] }> {
  const pageAny = page as unknown as Record<string, unknown>;
  if (typeof pageAny.readNetworkCapture === "function") {
    const rawEntries =
      (await (
        pageAny as {
          readNetworkCapture(): Promise<
            Array<{
              url: string;
              method: string;
              status: number;
              contentType: string;
              size: number;
              responseBody?: string;
            }>
          >;
        }
      ).readNetworkCapture()) ?? [];

    if (rawEntries.length > 0) {
      return {
        raw: rawEntries,
        normalized: rawEntries.map((entry) => ({
          url: entry.url,
          method: entry.method,
          status: entry.status,
          contentType: entry.contentType,
          bodySize: entry.size,
          ...(entry.responseBody ? { body: entry.responseBody } : {}),
        })),
      };
    }
  }

  try {
    const raw = (await page.evaluate(generateReadInterceptedJs())) as string;
    const parsed = JSON.parse(raw) as Array<{
      url: string;
      data?: unknown;
      type?: string;
      method?: string;
      status?: number;
    }>;
    if (parsed.length > 0) {
      return {
        raw: parsed,
        normalized: parsed.map((entry) => ({
          url: entry.url,
          method: entry.method ?? "GET",
          status: entry.status ?? 200,
          contentType:
            entry.type === "text" ? "text/plain" : "application/json",
          bodySize: entry.data == null ? 0 : JSON.stringify(entry.data).length,
          ...(entry.data !== undefined ? { body: entry.data } : {}),
        })),
      };
    }
  } catch {
    // Interceptor not installed or buffer malformed.
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
  page: DaemonPage,
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
