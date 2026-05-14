/**
 * @owner   Social browser runtime.
 * @does    Builds structured auth, challenge, and empty-result errors for social adapters.
 * @needs   Adapter page diagnostics from browser-backed commands.
 * @feeds   Social adapters and output/error-map.ts.
 * @breaks  Stale regexes can misclassify upstream login or challenge copy.
 */

export type SocialBrowserErrorCode =
  | "auth_required"
  | "challenge_required"
  | "empty_result"
  | "upstream_error"
  | "network_error";

export function socialBrowserError(
  code: SocialBrowserErrorCode,
  message: string,
  suggestion: string,
  alternatives: string[],
  retryable = code === "network_error",
): Error {
  const err = new Error(message) as Error & {
    code?: string;
    suggestion?: string;
    retryable?: boolean;
    alternatives?: string[];
  };
  err.code = code;
  err.suggestion = suggestion;
  err.retryable = retryable;
  err.alternatives = alternatives;
  return err;
}

export function socialAuthError(site: string, command: string): Error {
  return socialBrowserError(
    "auth_required",
    `${site} ${command} requires a logged-in browser session.`,
    `Open ${site} in your normal Chrome profile, finish login, then rerun with --auth-retry.`,
    [
      `unicli auth import ${site} --browser chrome`,
      `unicli browser open https://${site === "twitter" ? "x.com" : "www.xiaohongshu.com"}`,
      `unicli --auth-retry ${site} ${command}`,
    ],
    false,
  );
}

export function socialChallengeError(
  site: string,
  command: string,
  message: string,
): Error {
  return socialBrowserError(
    "challenge_required",
    message,
    `Resolve the visible ${site} verification or risk-control page in Chrome, then rerun with --auth-retry.`,
    [
      `unicli browser open https://${site === "twitter" ? "x.com" : "www.xiaohongshu.com"}`,
      `unicli --auth-retry ${site} ${command}`,
    ],
    true,
  );
}

export function socialEmptyError(
  site: string,
  command: string,
  message: string,
): Error {
  return socialBrowserError(
    "empty_result",
    message,
    `The page loaded but no parseable ${site} rows were found. Inspect the live browser page, then rerun after the page shows content.`,
    [
      `unicli describe ${site} ${command}`,
      `unicli browser state`,
      `unicli --auth-retry ${site} ${command}`,
    ],
    true,
  );
}
