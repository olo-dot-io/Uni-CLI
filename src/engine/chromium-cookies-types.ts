/**
 * Shared types for the chromium-cookies module. Split out to break a
 * circular import between `chromium-cookies.ts` (orchestration) and
 * `chromium-cookies-platform.ts` (per-platform crypto + keystore).
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
}

export interface ReadOptions {
  browser: BrowserId;
  domain: string;
  profile?: string;
}

export class ChromiumCookieError extends Error {
  constructor(
    public readonly code:
      | "browser_not_installed"
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
