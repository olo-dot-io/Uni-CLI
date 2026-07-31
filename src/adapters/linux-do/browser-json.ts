/**
 * @owner       src::adapters::linux-do::browser-json
 * @does        Reads Linux.do JSON endpoints inside the authenticated first-party browser origin.
 * @needs       A user-owned browser session with a valid Linux.do account.
 * @feeds       Every Linux.do read adapter.
 * @breaks      Login expiry, browser verification, or Discourse response drift surfaces as a typed failure.
 * @invariants  Requests stay same-origin; missing JSON and login responses are never accepted as empty data.
 * @side-effects Navigates one browser page and performs same-origin read-only fetches.
 * @perf        One home navigation and one endpoint request per command.
 * @concurrency The caller owns the page lease and cancellation signal.
 * @test        src/adapters/linux-do/browser-json.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import type { IPage } from "../../types.js";

export const LINUX_DO_HOME = "https://linux.do";

interface BrowserJsonResult {
  ok?: boolean;
  status?: number;
  contentType?: string;
  data?: unknown;
  error?: string;
}

interface ActionableLinuxDoError extends Error {
  code: string;
  suggestion: string;
  retryable: boolean;
  alternatives: string[];
}

function linuxDoAuthRequired(detail: string): ActionableLinuxDoError {
  return Object.assign(new Error(detail), {
    code: "auth_required",
    suggestion:
      "Sign in to https://linux.do in the selected browser profile, then retry with that same profile.",
    retryable: false,
    alternatives: [
      "unicli browser profiles --json",
      "unicli browser doctor --json",
      "unicli auth setup linux-do",
    ],
  });
}

function isLoginPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.login_required === true ||
    record.error_type === "not_logged_in" ||
    record.error_type === "invalid_access"
  );
}

export async function fetchLinuxDoJson(
  page: IPage,
  path: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError(`Linux.do API path must be same-origin: ${path}`);
  }

  await page.goto(LINUX_DO_HOME, { settleMs: 2_000 }, signal);
  const result = (await page.evaluate(
    `(async () => {
      try {
        const response = await fetch(${JSON.stringify(path)}, {
          credentials: "include",
          headers: { accept: "application/json" }
        });
        const contentType = response.headers.get("content-type") || "";
        let data = null;
        try { data = await response.json(); } catch {}
        return {
          ok: response.ok,
          status: response.status,
          contentType,
          data,
          error: data === null ? "Response is not valid JSON" : ""
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })()`,
    signal,
  )) as BrowserJsonResult | null;

  if (!result) {
    throw new Error("linux-do returned an empty browser response");
  }
  if (
    result.status === 401 ||
    result.status === 403 ||
    isLoginPayload(result.data) ||
    (result.ok && !result.contentType?.toLowerCase().includes("json"))
  ) {
    throw linuxDoAuthRequired(
      "Linux.do requires an active signed-in browser session.",
    );
  }
  if (!result.ok) {
    throw new Error(
      typeof result.status === "number"
        ? `linux-do request failed: HTTP ${result.status}`
        : result.error || "linux-do browser request failed",
    );
  }
  if (
    !result.data ||
    typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    throw linuxDoAuthRequired(
      "Linux.do returned a non-JSON login or browser-verification response.",
    );
  }
  return result.data as Record<string, unknown>;
}
