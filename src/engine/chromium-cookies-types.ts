/**
 * @owner   src/engine/chromium-cookies-types.ts
 * @does    Define shared Chromium cookie reader types and structured errors.
 * @needs   none
 * @feeds   src/engine/chromium-cookies.ts, src/engine/chromium-cookies-platform.ts, src/browser/auth-sync.ts, src/commands/auth.ts, scripts/browser-auth-default-acceptance.ts
 * @breaks  ChromiumCookieError carries unsupported-browser, profile discovery, keystore, sqlite, and decryption failure codes to callers.
 * @invariants Cookie rows expose decrypted values only to explicit auth/cookie import callers.
 * @side-effects none
 * @perf    none
 * @concurrency none
 * @test    tests/unit/chromium-cookies.test.ts
 * @stability stable
 * @since   2026-06-29
 */

export type BrowserId = "chrome" | "brave" | "edge" | "arc" | "dia" | "atlas";

export interface CookieRow {
  host: string;
  name: string;
  value: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  persistent: boolean;
  hasExpires: boolean;
}

export interface ReadOptions {
  browser: BrowserId;
  domain: string;
  profile?: string;
  userDataDir?: string;
}

export class ChromiumCookieError extends Error {
  constructor(
    public readonly code:
      | "browser_not_installed"
      | "browser_unsupported"
      | "no_profile"
      | "keychain_denied"
      | "encryption_unsupported"
      | "sqlite_failed"
      | "decrypt_failed"
      | "platform_unsupported",
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "ChromiumCookieError";
  }
}
