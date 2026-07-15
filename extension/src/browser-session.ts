/**
 * @owner       extension/src/browser-session.ts
 * @does        Persist one opaque Chrome-browser-session identity across extension service-worker restarts and clear it on full browser restart.
 * @needs       crypto.randomUUID, chrome.storage.session
 * @feeds       extension/src/background.ts and chrome-controller.ts
 * @breaks      Throws when session storage is unavailable or contains a malformed identity.
 * @invariants  One live Chrome browser session has one UUID; service-worker restarts reuse it; full browser restarts allocate a new UUID.
 * @side-effects Reads and writes one chrome.storage.session value.
 * @perf        One coalesced storage read per service-worker lifetime.
 * @concurrency Concurrent callers await the same initialization promise.
 * @test        tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

const STORAGE_KEY = "unicli_browser_session_id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let browserSessionPromise: Promise<string> | null = null;

export function getChromeBrowserSessionId(): Promise<string> {
  browserSessionPromise ??= initializeBrowserSessionId();
  return browserSessionPromise;
}

async function initializeBrowserSessionId(): Promise<string> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY];
  if (typeof existing === "string" && UUID_PATTERN.test(existing)) {
    return existing;
  }
  if (existing !== undefined) {
    throw new Error("Chrome browser session identity is malformed");
  }
  const created = crypto.randomUUID();
  await chrome.storage.session.set({ [STORAGE_KEY]: created });
  return created;
}
