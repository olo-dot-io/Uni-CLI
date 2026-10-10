/**
 * @owner       src::engine::download
 * @does        Transactionally streams HTTP content or invokes yt-dlp, while providing filename and bounded-concurrency utilities.
 * @needs       validated proxy-aware fetch, transactional file publication, node streams/fs/path, yt-dlp subprocess when selected
 * @feeds       download pipeline action, HTTP transport, scholarly/media adapters, public package download export
 * @breaks      Direct destination writes can replace valid artifacts after cancellation; ordinary HTTP, stream, filesystem, and subprocess failures return explicit failed DownloadResult values.
 * @invariants  HTTP downloads validate every redirect hop, retain the legacy headers/signal call shape, publish only by atomic rename, preserve prior destinations on abort, and rethrow the exact cancellation reason; yt-dlp receives caller cancellation and a bounded timeout; result order is preserved.
 * @side-effects Creates directories/files and may launch yt-dlp.
 * @perf        HTTP streams without whole-body buffering; mapConcurrent is caller-bounded.
 * @concurrency Worker-pool mapping preserves input order; each destination stream has one owner.
 * @test        tests/unit/download.test.ts, tests/unit/engine/steps/download-cancellation.test.ts, and adapter download suites
 * @stability   public
 * @since       2026-04-03
 */

import { execFile } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { publishFileTransactionally } from "./transactional-file.js";
import { PipelineError } from "./executor.js";
import {
  fetchHttpResource,
  isHtmlVerificationChallenge,
  challengeRequiredError,
} from "./http-response.js";
import { acquireRequestCookieHeader } from "./request-credentials.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DownloadResult {
  status: "success" | "skipped" | "failed";
  path?: string;
  size?: number;
  error?: string;
  duration?: number;
  code?: string;
  statusCode?: number;
  contentType?: string;
  finalUrl?: string;
}

export interface HttpDownloadOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  validateRequest?: (url: string) => void;
  maxBytes?: number;
}

function isHttpDownloadOptions(
  value: HttpDownloadOptions | Record<string, string>,
): value is HttpDownloadOptions {
  const candidate = value as Record<string, unknown>;
  return (
    (Object.hasOwn(candidate, "headers") &&
      (candidate.headers === undefined ||
        (typeof candidate.headers === "object" &&
          candidate.headers !== null))) ||
    (Object.hasOwn(candidate, "signal") &&
      (candidate.signal === undefined ||
        (typeof candidate.signal === "object" &&
          candidate.signal !== null &&
          "aborted" in candidate.signal))) ||
    typeof candidate.validateRequest === "function" ||
    typeof candidate.maxBytes === "number"
  );
}

function normalizeHttpDownloadOptions(
  value: HttpDownloadOptions | Record<string, string>,
  legacySignal: AbortSignal | undefined,
): HttpDownloadOptions {
  if (isHttpDownloadOptions(value)) {
    if (legacySignal !== undefined) {
      throw new TypeError(
        "httpDownload cannot combine an options object with the legacy fourth signal argument.",
      );
    }
    return value;
  }
  return { headers: value, signal: legacySignal };
}

// ---------------------------------------------------------------------------
// URL / filename utilities
// ---------------------------------------------------------------------------

/** Video platform pattern — URLs that require yt-dlp. */
const VIDEO_PLATFORMS =
  /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|dailymotion\.com|tiktok\.com|douyin\.com|twitter\.com\/.*\/video/i;
const FILENAME_UNSAFE_CHARS = '<>:"/\\|?*';

function replaceUnsafeFilenameChars(value: string): string {
  let out = "";
  for (const ch of value) {
    out +=
      ch.charCodeAt(0) <= 31 || FILENAME_UNSAFE_CHARS.includes(ch) ? "_" : ch;
  }
  return out;
}

/** Return true when a URL should be handled by yt-dlp rather than fetch(). */
export function requiresYtdlp(url: string): boolean {
  return VIDEO_PLATFORMS.test(url);
}

/** Replace filesystem-unsafe characters and strip leading dots. */
export function sanitizeFilename(name: string): string {
  return (
    replaceUnsafeFilenameChars(name).replace(/^\.+/, "").trim() || "download"
  );
}

/**
 * Derive a filename from a URL.
 * Falls back to `download_<index>` when the path segment has no extension.
 */
export function generateFilename(url: string, index: number): string {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").pop() ?? "";
    if (base && base.includes(".")) return sanitizeFilename(base);
  } catch {
    // Not a valid URL — fall through
  }
  return `download_${index}`;
}

// ---------------------------------------------------------------------------
// HTTP download (streaming)
// ---------------------------------------------------------------------------

/**
 * Stream a URL to disk using Node.js fetch + Readable.fromWeb().
 * Creates parent directories automatically.
 */
export function httpDownload(
  url: string,
  destPath: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<DownloadResult>;
export function httpDownload(
  url: string,
  destPath: string,
  options?: HttpDownloadOptions,
): Promise<DownloadResult>;
export async function httpDownload(
  url: string,
  destPath: string,
  optionsOrHeaders: HttpDownloadOptions | Record<string, string> = {},
  legacySignal?: AbortSignal,
): Promise<DownloadResult> {
  const options = normalizeHttpDownloadOptions(optionsOrHeaders, legacySignal);
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)
  )
    throw new TypeError("maxBytes must be a positive safe integer");
  const t0 = Date.now();
  const { signal } = options;
  const headers = new Headers(options.headers);
  const explicitCredentials =
    headers.has("cookie") || headers.has("authorization");
  const usedCookies = new Set<string>();
  let credentialOrigin: string | undefined;
  let requestUrl = url;
  const failure = (message: string, code: string) =>
    new PipelineError(message, {
      action: "download",
      step: -1,
      config: { url: requestUrl },
      url: requestUrl,
      errorType: code,
      preserveErrorCode: true,
      retryable: false,
      suggestion:
        "Check the resource, byte limit, and output path, then retry the download.",
    });
  try {
    signal?.throwIfAborted();
    await mkdir(dirname(destPath), { recursive: true });
    for (let attempt = 0; ; attempt++) {
      try {
        let contentType = "";
        await publishFileTransactionally(
          destPath,
          async (temporaryPath) => {
            await fetchHttpResource(
              requestUrl,
              { headers, signal },
              {
                action: "fetch",
                step: -1,
                retry: 2,
                validateRequest: options.validateRequest,
              },
              async (res, finalUrl) => {
                requestUrl = finalUrl;
                contentType =
                  res.headers
                    .get("content-type")
                    ?.split(";", 1)[0]
                    .trim()
                    .toLowerCase() ?? "";
                if (!res.body)
                  throw failure("Response body is null", "empty_result");
                if (
                  options.maxBytes !== undefined &&
                  Number(res.headers.get("content-length")) > options.maxBytes
                ) {
                  await res.body.cancel();
                  throw failure(
                    `Resource exceeds ${options.maxBytes} bytes`,
                    "response_too_large",
                  );
                }
                try {
                  const ws = createWriteStream(temporaryPath, { flags: "wx" });
                  const readable = Readable.fromWeb(
                    res.body as Parameters<typeof Readable.fromWeb>[0],
                  );
                  if (options.maxBytes === undefined) {
                    await pipeline(readable, ws, signal ? { signal } : {});
                  } else {
                    let bytes = 0;
                    const limit = new Transform({
                      transform(chunk: Buffer, _encoding, callback) {
                        bytes += chunk.byteLength;
                        callback(
                          bytes > options.maxBytes!
                            ? failure(
                                `Resource exceeds ${options.maxBytes} bytes`,
                                "response_too_large",
                              )
                            : null,
                          chunk,
                        );
                      },
                    });
                    await pipeline(
                      readable,
                      limit,
                      ws,
                      signal ? { signal } : {},
                    );
                  }
                  if (
                    /^(?:text\/html|application\/xhtml\+xml|text\/plain)$/.test(
                      contentType,
                    )
                  ) {
                    const file = await open(temporaryPath, "r");
                    try {
                      const prefix = Buffer.alloc(64 * 1024);
                      const { bytesRead } = await file.read(
                        prefix,
                        0,
                        prefix.length,
                        0,
                      );
                      if (
                        isHtmlVerificationChallenge(
                          prefix.subarray(0, bytesRead).toString("utf8"),
                        )
                      )
                        throw challengeRequiredError(
                          finalUrl,
                          "download",
                          -1,
                          res.status,
                        );
                    } finally {
                      await file.close();
                    }
                  }
                } catch (error) {
                  try {
                    await unlink(temporaryPath);
                  } catch (cleanupError) {
                    if (
                      (cleanupError as NodeJS.ErrnoException).code !== "ENOENT"
                    )
                      throw failure(
                        `Cannot remove incomplete download: ${String(cleanupError)}`,
                        "download_failed",
                      );
                  }
                  signal?.throwIfAborted();
                  const ioError = error as NodeJS.ErrnoException;
                  if (
                    ioError?.path ||
                    ["write", "open", "close"].includes(ioError?.syscall ?? "")
                  )
                    throw failure(
                      error instanceof Error ? error.message : String(error),
                      ioError.code ?? "download_failed",
                    );
                  throw error;
                }
              },
            );
          },
          { signal },
        );
        const { size } = await stat(destPath);
        return {
          status: "success",
          path: destPath,
          size,
          duration: Date.now() - t0,
          contentType,
          finalUrl: requestUrl,
        };
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof PipelineError)) throw error;
        if (error.detail.url) requestUrl = error.detail.url;
        if (
          !explicitCredentials &&
          attempt < 2 &&
          (error.detail.statusCode === 401 ||
            error.detail.statusCode === 403 ||
            error.detail.errorType === "challenge_required")
        ) {
          const cookie = await acquireRequestCookieHeader(requestUrl, {
            fresh:
              attempt === 1 && credentialOrigin === new URL(requestUrl).origin,
            signal,
          });
          const identity = `${new URL(requestUrl).origin}\n${cookie}`;
          if (cookie && !usedCookies.has(identity)) {
            usedCookies.add(identity);
            credentialOrigin = new URL(requestUrl).origin;
            headers.set("cookie", cookie);
            continue;
          }
        }
        throw error;
      }
    }
  } catch (err) {
    signal?.throwIfAborted();
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      code:
        err instanceof PipelineError
          ? (err.detail.errorType ?? "download_failed")
          : typeof (err as { code?: unknown })?.code === "string"
            ? (err as { code: string }).code
            : "download_failed",
      ...(err instanceof PipelineError && err.detail.statusCode !== undefined
        ? { statusCode: err.detail.statusCode }
        : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// yt-dlp download
// ---------------------------------------------------------------------------

/**
 * Download a video URL via yt-dlp.
 * Parses yt-dlp stdout to locate the actual output file.
 */
export async function ytdlpDownload(
  url: string,
  dir: string,
  opts?: {
    cookieFile?: string;
    cookiesFromBrowser?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<DownloadResult> {
  const t0 = Date.now();
  try {
    opts?.signal?.throwIfAborted();
    mkdirSync(dir, { recursive: true });

    const args = buildYtdlpDownloadArgs(url, dir, opts);

    const { stdout } = await execFileAsync("yt-dlp", args, {
      timeout: opts?.timeoutMs ?? 5 * 60 * 1000,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    // Parse output path — yt-dlp prints "Destination: <path>" or
    // "[Merger] Merging formats into "<path>""
    let filePath: string | undefined;

    const destMatch = stdout.match(/Destination:\s*(.+)/);
    if (destMatch) {
      filePath = destMatch[1].trim();
    }

    const mergeMatch = stdout.match(/Merging formats into\s+"([^"]+)"/);
    if (mergeMatch) {
      filePath = mergeMatch[1].trim();
    }

    let size: number | undefined;
    if (filePath) {
      try {
        size = statSync(filePath).size;
      } catch {
        // File may have been moved or remuxed — size stays undefined
      }
    }

    return {
      status: "success",
      path: filePath,
      size,
      duration: Date.now() - t0,
    };
  } catch (err) {
    opts?.signal?.throwIfAborted();
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildYtdlpDownloadArgs(
  url: string,
  dir: string,
  opts?: { cookieFile?: string; cookiesFromBrowser?: string },
): string[] {
  const args = [url, "-o", `${dir}/%(title)s.%(ext)s`, "--no-warnings"];
  if (opts?.cookieFile) {
    args.push("--cookies", opts.cookieFile);
  }
  if (opts?.cookiesFromBrowser) {
    args.push("--cookies-from-browser", opts.cookiesFromBrowser);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Concurrent map utility
// ---------------------------------------------------------------------------

/**
 * Process an array with bounded concurrency, preserving result order.
 *
 * Uses a worker-pool pattern: `min(concurrency, items.length)` workers
 * each pull from a shared index counter until the array is exhausted.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  if (items.length === 0) return [];

  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (!failed) {
      const index = nextIndex++;
      if (index >= items.length) break;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
  if (failed) throw failure;

  return results;
}
