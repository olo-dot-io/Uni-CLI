/**
 * @owner       src::adapters::openreview::client
 * @does        Provides authenticated, paced, retrying OpenReview API reads and transactional attachment downloads.
 * @needs       OpenReview v1/v2 APIs, browser-derived OpenReview cookies, filesystem streams.
 * @feeds       OpenReview paper and conference-archive commands.
 * @breaks      Auth, challenge, rate-limit, and upstream failures retain actionable identities; downloads never publish partial files.
 * @invariants  Access/clearance cookies cross only to OpenReview hosts; refresh cookies cross only to OpenReview's refreshToken endpoint; requests are strictly spaced and serial.
 * @side-effects HTTPS reads, intentional waits, and caller-directed artifact writes.
 * @perf        One active OpenReview request per process with configurable strict spacing and bounded retry.
 * @concurrency Process-wide scheduling serializes OpenReview requests across adapter commands.
 * @test        src/adapters/openreview/client.test.ts
 * @stability   experimental
 * @since       2026-08-02
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  formatCookieHeader,
  loadCookiesWithCDP,
} from "../../engine/cookies.js";
import { publishFileTransactionally } from "../../engine/transactional-file.js";

export type OpenReviewApiVersion = 1 | 2;

export const OPENREVIEW_WEB_BASE = "https://openreview.net";
export const OPENREVIEW_API_BASES: Record<OpenReviewApiVersion, string> = {
  1: "https://api.openreview.net",
  2: "https://api2.openreview.net",
};

export interface OpenReviewDownloadResult {
  status: "success";
  path: string;
  size: number;
  sha256: string;
  content_type: string;
  content_disposition: string;
  source_url: string;
}

export interface OpenReviewHttpClientOptions {
  apiVersion?: OpenReviewApiVersion;
  rpm?: number;
  maxRetries?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  loadCookies?: () => Promise<Record<string, string> | null>;
}

interface ActionableOpenReviewError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
  status?: number;
  retry_after_ms?: number;
}

let requestTail: Promise<void> = Promise.resolve();
let nextRequestAt = 0;
let strictestRpm = Number.POSITIVE_INFINITY;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveInteger(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${label} must be an integer in [1, ${max}].`);
  }
  return value;
}

export function openReviewCookieHeader(
  cookies: Record<string, string> | null,
): string | undefined {
  if (!cookies) return undefined;
  const allowed: Record<string, string> = {};
  for (const name of ["openreview.accessToken", "openreview.clearanceToken"]) {
    const value = cookies[name];
    if (value) allowed[name] = value;
  }
  return Object.keys(allowed).length > 0
    ? formatCookieHeader(allowed)
    : undefined;
}

export function openReviewChallengeUrl(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      name?: unknown;
      status?: unknown;
      details?: { challengeUrl?: unknown };
    };
    const url = parsed.details?.challengeUrl;
    return parsed.name === "ChallengeRequiredError" &&
      parsed.status === 403 &&
      typeof url === "string" &&
      url.startsWith("https://openreview.net/challenge?")
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export function retryAfterMilliseconds(
  value: string | null,
  now = Date.now(),
): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function readOpenReviewContent(
  content: Record<string, unknown> | undefined,
  key: string,
): unknown {
  const field = content?.[key];
  if (
    field &&
    typeof field === "object" &&
    !Array.isArray(field) &&
    Object.hasOwn(field, "value")
  ) {
    return (field as { value?: unknown }).value;
  }
  return field;
}

export function isOpenReviewUrl(value: string): boolean {
  try {
    const host = new URL(value, OPENREVIEW_WEB_BASE).hostname.toLowerCase();
    return (
      host === "openreview.net" ||
      host === "api.openreview.net" ||
      host === "api2.openreview.net"
    );
  } catch {
    return false;
  }
}

function actionableError(
  message: string,
  fields: Omit<ActionableOpenReviewError, keyof Error | "name" | "message">,
): ActionableOpenReviewError {
  return Object.assign(new Error(message), fields);
}

function challengeError(
  challengeUrl: string,
  label: string,
): ActionableOpenReviewError {
  const openCommand = `unicli browser open ${JSON.stringify(challengeUrl)}`;
  const captureCommand =
    "unicli browser cookies openreview.net --save-as openreview";
  return actionableError(
    `OpenReview requires browser verification for ${label}.`,
    {
      code: "challenge_required",
      suggestion: `${openCommand}; wait for the redirect, then run \`${captureCommand}\` and retry with --auth-retry.`,
      retryable: false,
      alternatives: [openCommand, captureCommand],
      status: 403,
    },
  );
}

function authenticationError(
  label: string,
  detail: string,
  status: number,
): ActionableOpenReviewError {
  return actionableError(
    `OpenReview authentication failed for ${label}${detail ? ` (${detail})` : ""}.`,
    {
      code: "auth_required",
      suggestion:
        "Refresh the logged-in browser session and rerun with --auth-retry, or import that profile with `unicli browser cookies openreview.net --save-as openreview`.",
      retryable: false,
      alternatives: [
        "unicli browser profiles --json",
        "unicli browser doctor --json",
        "unicli browser cookies openreview.net --save-as openreview",
      ],
      status,
    },
  );
}

function rateLimitError(
  label: string,
  status: number,
  waitMs: number,
): ActionableOpenReviewError {
  return actionableError(
    `OpenReview rate limit remained active for ${label} after bounded retries.`,
    {
      code: "rate_limited",
      suggestion: `Wait at least ${Math.ceil(waitMs / 1000)} seconds, then resume the same command; its checkpoint prevents duplicate downloads.`,
      retryable: true,
      alternatives: [],
      status,
      retry_after_ms: waitMs,
    },
  );
}

async function scheduleRequest(
  rpm: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  strictestRpm = Math.min(strictestRpm, rpm);
  const interval = Math.ceil(60_000 / strictestRpm);
  const scheduled = requestTail.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    nextRequestAt = Date.now() + interval;
  });
  requestTail = scheduled.catch(() => undefined);
  await scheduled;
}

function contentErrorDetail(body: string): {
  name: string;
  detail: string;
} {
  try {
    const parsed = JSON.parse(body) as {
      name?: unknown;
      message?: unknown;
      error?: unknown;
    };
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      detail:
        typeof parsed.message === "string"
          ? parsed.message.slice(0, 300)
          : typeof parsed.error === "string"
            ? parsed.error.slice(0, 300)
            : body.slice(0, 300),
    };
  } catch {
    return { name: "", detail: body.slice(0, 300) };
  }
}

function observeRateLimitHeaders(response: Response): void {
  const remaining = Number(
    response.headers.get("ratelimit-remaining") ??
      response.headers.get("x-ratelimit-remaining"),
  );
  const reset = Number(
    response.headers.get("ratelimit-reset") ??
      response.headers.get("x-ratelimit-reset"),
  );
  if (Number.isFinite(remaining) && remaining <= 1 && reset > 0) {
    nextRequestAt = Math.max(nextRequestAt, Date.now() + reset * 1000);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class OpenReviewHttpClient {
  readonly apiVersion: OpenReviewApiVersion;
  readonly rpm: number;
  readonly maxRetries: number;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly cookieLoader: () => Promise<Record<string, string> | null>;
  private cookiesPromise?: Promise<Record<string, string> | null>;
  private sessionAccessToken?: string;
  private refreshAttempted = false;

  constructor(options: OpenReviewHttpClientOptions = {}) {
    this.apiVersion = options.apiVersion ?? 2;
    this.rpm = positiveInteger(options.rpm ?? 20, "openreview rpm", 180);
    this.maxRetries = positiveInteger(
      options.maxRetries ?? 8,
      "openreview max retries",
      12,
    );
    this.fetcher = options.fetcher ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.random = options.random ?? Math.random;
    this.cookieLoader =
      options.loadCookies ??
      (() => loadCookiesWithCDP("openreview", "openreview.net"));
  }

  apiUrl(path: string): string {
    return `${OPENREVIEW_API_BASES[this.apiVersion]}${path.startsWith("/") ? path : `/${path}`}`;
  }

  async headers(accept = "application/json"): Promise<Record<string, string>> {
    const cookies = await this.cookies();
    const headers: Record<string, string> = {
      "User-Agent":
        "unicli-openreview/1.0 (+https://github.com/olo-dot-io/Uni-CLI)",
      Accept: accept,
    };
    const cookie = openReviewCookieHeader(cookies);
    if (cookie) headers.Cookie = cookie;
    const token = (
      this.sessionAccessToken ?? cookies?.["openreview.accessToken"]
    )?.replace(/^Bearer\s+/i, "");
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  private cookies(): Promise<Record<string, string> | null> {
    this.cookiesPromise ??= this.cookieLoader();
    return this.cookiesPromise;
  }

  private async refreshAccessToken(label: string): Promise<boolean> {
    if (this.refreshAttempted) return false;
    this.refreshAttempted = true;
    const cookies = await this.cookies();
    const refreshToken = cookies?.["openreview.refreshToken"];
    if (!refreshToken) return false;

    await scheduleRequest(this.rpm, this.sleep);
    let response: Response;
    try {
      response = await this.fetcher(`${OPENREVIEW_API_BASES[2]}/refreshToken`, {
        method: "POST",
        headers: {
          "User-Agent":
            "unicli-openreview/1.0 (+https://github.com/olo-dot-io/Uni-CLI)",
          Accept: "application/json,text/*;q=0.99",
          "Content-Type": "application/json; charset=UTF-8",
          Cookie: formatCookieHeader({
            "openreview.refreshToken": refreshToken,
          }),
          "X-Source": "unicli-openreview",
          "X-Url": `${OPENREVIEW_API_BASES[this.apiVersion]}/${label}`,
        },
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const data = (await response.json().catch(() => ({}))) as {
      token?: unknown;
    };
    if (typeof data.token !== "string" || !data.token) return false;
    this.sessionAccessToken = data.token;
    return true;
  }

  async request(
    pathOrUrl: string,
    label: string,
    accept = "application/json",
  ): Promise<Response | undefined> {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : this.apiUrl(pathOrUrl);
    if (!isOpenReviewUrl(url)) {
      throw new Error(`Refusing non-OpenReview request URL: ${url}`);
    }
    let headers = await this.headers(accept);
    let lastWaitMs = 60_000;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await scheduleRequest(this.rpm, this.sleep);
      let response: Response;
      try {
        response = await this.fetcher(url, { headers });
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        const waitMs =
          Math.min(120_000, 1000 * 2 ** attempt) +
          Math.floor(this.random() * 1000);
        await this.sleep(waitMs);
        continue;
      }

      if (response.status === 404) return undefined;
      if (response.ok) {
        observeRateLimitHeaders(response);
        return response;
      }

      const body = await response.text().catch(() => "");
      const challengeUrl = openReviewChallengeUrl(body);
      if (response.status === 403 && challengeUrl) {
        throw challengeError(challengeUrl, label);
      }
      const parsed = contentErrorDetail(body);
      if (
        response.status === 401 ||
        parsed.name === "TokenExpiredError" ||
        parsed.name === "UnauthenticatedError"
      ) {
        if (await this.refreshAccessToken(label)) {
          headers = await this.headers(accept);
          attempt -= 1;
          continue;
        }
        throw authenticationError(label, parsed.detail, response.status);
      }

      const retryable =
        (response.status === 400 &&
          /operation exceeded time limit|try again in a few minutes/i.test(
            parsed.detail,
          )) ||
        response.status === 408 ||
        response.status === 429 ||
        response.status === 500 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504;
      if (retryable) {
        const headerWait = retryAfterMilliseconds(
          response.headers.get("retry-after"),
        );
        const resetSeconds = Number(response.headers.get("ratelimit-reset"));
        const resetWait =
          Number.isFinite(resetSeconds) && resetSeconds > 0
            ? Math.ceil(resetSeconds * 1000)
            : undefined;
        lastWaitMs =
          headerWait ??
          resetWait ??
          Math.min(120_000, 1000 * 2 ** attempt) +
            Math.floor(this.random() * 1000);
        if (attempt < this.maxRetries) {
          await this.sleep(lastWaitMs);
          continue;
        }
        if (response.status === 429) {
          throw rateLimitError(label, response.status, lastWaitMs);
        }
      }

      throw actionableError(
        `OpenReview API HTTP ${response.status} for ${label}${parsed.detail ? ` (${parsed.detail})` : ""}.`,
        {
          code: retryable ? "upstream_error" : "internal_error",
          suggestion: retryable
            ? "Resume after a short delay; the OpenReview archive checkpoint is durable."
            : "Inspect the OpenReview response and adapter request parameters.",
          retryable,
          alternatives: [],
          status: response.status,
        },
      );
    }

    throw rateLimitError(label, 429, lastWaitMs);
  }

  async json<T>(path: string, label: string): Promise<T | undefined> {
    const response = await this.request(path, label, "application/json");
    if (!response) return undefined;
    return (await response.json()) as T;
  }

  async download(
    pathOrUrl: string,
    destination: string,
    label: string,
  ): Promise<OpenReviewDownloadResult | undefined> {
    const response = await this.request(
      pathOrUrl,
      label,
      "application/pdf,application/zip,application/octet-stream,*/*",
    );
    if (!response) return undefined;
    if (!response.body) {
      throw new Error(`OpenReview returned an empty body for ${label}.`);
    }
    await mkdir(dirname(destination), { recursive: true });
    const hash = createHash("sha256");
    await publishFileTransactionally(destination, async (temporaryPath) => {
      const hasher = new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
        hasher,
        createWriteStream(temporaryPath, { flags: "wx" }),
      );
    });
    const file = await stat(destination);
    return {
      status: "success",
      path: destination,
      size: file.size,
      sha256: hash.digest("hex") || (await sha256File(destination)),
      content_type: response.headers.get("content-type") ?? "",
      content_disposition: response.headers.get("content-disposition") ?? "",
      source_url: /^https?:\/\//i.test(pathOrUrl)
        ? pathOrUrl
        : this.apiUrl(pathOrUrl),
    };
  }
}

export function resetOpenReviewRequestSchedulerForTests(): void {
  requestTail = Promise.resolve();
  nextRequestAt = 0;
  strictestRpm = Number.POSITIVE_INFINITY;
}
