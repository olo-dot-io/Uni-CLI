/**
 * Download pipeline step — HTTP streaming, yt-dlp video, document save.
 *
 * Three modes:
 *   1. httpDownload  — fetch() + stream to disk (any URL)
 *   2. ytdlpDownload — shell out to yt-dlp for video platforms
 *   3. document save — writeFileSync (caller supplies content)
 *
 * Utility exports:
 *   requiresYtdlp   — detect video platform URLs
 *   sanitizeFilename — make names filesystem-safe
 *   generateFilename — derive name from URL
 *   mapConcurrent   — bounded-concurrency async map
 */

import { execFile } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

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
}

// ---------------------------------------------------------------------------
// URL / filename utilities
// ---------------------------------------------------------------------------

/** Video platform pattern — URLs that require yt-dlp. */
const VIDEO_PLATFORMS =
  /youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|dailymotion\.com|tiktok\.com|douyin\.com|twitter\.com\/.*\/video/i;

/** Return true when a URL should be handled by yt-dlp rather than fetch(). */
export function requiresYtdlp(url: string): boolean {
  return VIDEO_PLATFORMS.test(url);
}

/** Replace filesystem-unsafe characters and strip leading dots. */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/^\.+/, "")
      .trim() || "download"
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
export async function httpDownload(
  url: string,
  destPath: string,
  headers?: Record<string, string>,
): Promise<DownloadResult> {
  const t0 = Date.now();
  try {
    mkdirSync(dirname(destPath), { recursive: true });

    const res = await fetch(url, { headers });
    if (!res.ok) {
      return {
        status: "failed",
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    if (!res.body) {
      return { status: "failed", error: "Response body is null" };
    }

    const ws = createWriteStream(destPath);
    // `res.body` is a web ReadableStream — Node 18+ supports fromWeb()
    const readable = Readable.fromWeb(
      res.body as Parameters<typeof Readable.fromWeb>[0],
    );

    await new Promise<void>((resolve, reject) => {
      readable.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      readable.on("error", reject);
    });

    const { size } = statSync(destPath);
    return {
      status: "success",
      path: destPath,
      size,
      duration: Date.now() - t0,
    };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
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
  opts?: { cookieFile?: string },
): Promise<DownloadResult> {
  const t0 = Date.now();
  try {
    mkdirSync(dir, { recursive: true });

    const args = [url, "-o", `${dir}/%(title)s.%(ext)s`, "--no-warnings"];

    if (opts?.cookieFile) {
      args.push("--cookies", opts.cookieFile);
    }

    const { stdout } = await execFileAsync("yt-dlp", args, {
      timeout: 5 * 60 * 1000, // 5 min
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
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) break;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);

  return results;
}
