import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_NETWORK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_BODY_CHARS = 1_000_000;

export interface NetworkEntryInput {
  url: string;
  method: string;
  status: number;
  contentType: string;
  bodySize: number;
  body?: unknown;
}

export interface CachedNetworkEntry {
  key: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  bodySize: number;
  body?: unknown;
  body_truncated?: boolean;
  body_full_size?: number;
}

export interface NetworkCacheFile {
  version: 1;
  workspace: string;
  savedAt: string;
  entries: CachedNetworkEntry[];
}

export interface LoadNetworkCacheOptions {
  baseDir?: string;
  ttlMs?: number;
  now?: number;
}

export type LoadNetworkCacheResult =
  | { status: "ok"; file: NetworkCacheFile; ageMs: number }
  | { status: "missing" | "corrupt" }
  | { status: "expired"; file: NetworkCacheFile; ageMs: number };

function defaultCacheDir(): string {
  return join(homedir(), ".unicli", "cache");
}

export function networkCachePath(
  workspace: string,
  baseDir = defaultCacheDir(),
): string {
  const safe = workspace.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return join(baseDir, "browser-network", `${safe}.json`);
}

function bodyToSizedValue(body: unknown): {
  body?: unknown;
  body_truncated?: boolean;
  body_full_size?: number;
} {
  if (body === undefined) return {};
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  if (raw.length <= MAX_STORED_BODY_CHARS) return { body };
  return {
    body: raw.slice(0, MAX_STORED_BODY_CHARS),
    body_truncated: true,
    body_full_size: raw.length,
  };
}

function keyFor(entry: NetworkEntryInput, index: number): string {
  let slug = "request";
  try {
    const u = new URL(entry.url);
    slug =
      u.pathname
        .split("/")
        .filter(Boolean)
        .filter((part) => part !== "api" && !/^v\d+$/i.test(part))
        .slice(-2)
        .join("-")
        .replace(/[^a-zA-Z0-9_-]+/g, "-") || "root";
  } catch {
    // keep fallback slug
  }
  const hash = createHash("sha1")
    .update(`${entry.method.toUpperCase()} ${entry.url} ${String(index)}`)
    .digest("hex")
    .slice(0, 8);
  return `${entry.method.toLowerCase()}-${slug}-${hash}`;
}

export function toCachedNetworkEntries(
  entries: NetworkEntryInput[],
): CachedNetworkEntry[] {
  return entries.map((entry, index) => ({
    key: keyFor(entry, index),
    url: entry.url,
    method: entry.method.toUpperCase(),
    status: entry.status,
    contentType: entry.contentType,
    bodySize: entry.bodySize,
    ...bodyToSizedValue(entry.body),
  }));
}

export function saveNetworkCache(
  workspace: string,
  entries: CachedNetworkEntry[],
  baseDir?: string,
): string {
  const target = networkCachePath(workspace, baseDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify(
      { version: 1, workspace, savedAt: new Date().toISOString(), entries },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  return target;
}

export function loadNetworkCache(
  workspace: string,
  opts: LoadNetworkCacheOptions = {},
): LoadNetworkCacheResult {
  const target = networkCachePath(workspace, opts.baseDir);
  if (!existsSync(target)) return { status: "missing" };

  let parsed: NetworkCacheFile;
  try {
    const raw = readFileSync(target, "utf-8");
    const value = JSON.parse(raw) as NetworkCacheFile;
    if (value.version !== 1 || !Array.isArray(value.entries)) {
      return { status: "corrupt" };
    }
    parsed = value;
  } catch {
    return { status: "corrupt" };
  }

  const savedAt = Date.parse(parsed.savedAt);
  if (!Number.isFinite(savedAt)) return { status: "corrupt" };
  const ageMs = (opts.now ?? Date.now()) - savedAt;
  const ttlMs = opts.ttlMs ?? DEFAULT_NETWORK_CACHE_TTL_MS;
  if (ageMs > ttlMs) return { status: "expired", file: parsed, ageMs };
  return { status: "ok", file: parsed, ageMs };
}

export function findNetworkCacheEntry(
  file: NetworkCacheFile,
  key: string,
): CachedNetworkEntry | null {
  return file.entries.find((entry) => entry.key === key) ?? null;
}

export type ParsedNetworkFilter =
  | { ok: true; fields: string[] }
  | { ok: false; reason: string };

export function parseNetworkFilter(raw: string): ParsedNetworkFilter {
  const fields = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (fields.length === 0) {
    return {
      ok: false,
      reason: "--filter value must be a non-empty comma-separated field list",
    };
  }
  return { ok: true, fields };
}

function normalizeBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function collectSegments(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSegments(item, out);
    return;
  }
  if (value == null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    collectSegments(child, out);
  }
}

export function bodyMatchesNetworkFilter(
  body: unknown,
  fields: string[],
): boolean {
  const segments = new Set<string>();
  collectSegments(normalizeBody(body), segments);
  return fields.every((field) => segments.has(field));
}

export function truncateNetworkBody(
  entry: CachedNetworkEntry,
  maxChars: number,
): CachedNetworkEntry {
  const copy: CachedNetworkEntry = { ...entry };
  if (maxChars <= 0 || copy.body === undefined) return copy;
  const raw =
    typeof copy.body === "string" ? copy.body : JSON.stringify(copy.body);
  if (raw.length <= maxChars) return copy;
  copy.body = raw.slice(0, maxChars);
  copy.body_truncated = true;
  copy.body_full_size = raw.length;
  return copy;
}
