/**
 * @owner       src::engine::cookie-source
 * @does        Multi-source cookie acquisition that surfaces the REAL cause of a
 *              miss (keychain denied / corrupt file / v20 encryption / CDP
 *              unavailable) as a typed outcome, instead of collapsing every
 *              failure to null.
 * @needs       node:fs, node:path, ./chromium-cookies (lazy), ./cookie-extractor (lazy), ../browser/local-profiles (lazy)
 * @feeds       src::engine::cookies (loadCookies/loadCookiesWithCDP/acquireCookies
 *              projections), src::engine::executor (auth error detail)
 * @breaks      never throws from loadCookiesWithDiagnostics — failures become
 *              CookieLoadOutcome {status:"error", reasons}; readDiskCookies is total
 * @invariants  exactly one of loaded|absent|error; "absent" ⇒ no source errored
 *              (genuinely not logged in); "error" ⇒ ≥1 source had a real failure
 * @side-effects readDiskCookies reads fs; default sources read browser DB / CDP
 * @perf        disk O(file); browser tries installed browsers in order, stops on hit
 * @concurrency stateless; sources own their own IO
 * @test        tests/unit/engine/cookie-source.test.ts
 * @stability   experimental
 * @since       2026-05-30
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export type CookieSourceName = "disk" | "browser" | "cdp";

/** A typed failure cause from one acquisition source. */
export interface CookieReason {
  source: CookieSourceName;
  /** Stable code, e.g. corrupt_file | keychain_denied | encryption_unsupported | cdp_unavailable. */
  code: string;
  detail: string;
}

/**
 * Result of trying every cookie source for a site. Discriminated so callers
 * cannot confuse "genuinely not logged in" (absent) with "Keychain denied /
 * file corrupt / Chrome v20" (error) — the distinction the old null collapse
 * destroyed.
 */
export type CookieLoadOutcome =
  | {
      status: "loaded";
      source: CookieSourceName;
      cookies: Record<string, string>;
    }
  | { status: "absent" }
  | { status: "error"; reasons: CookieReason[] };

/** Disk read distinguishes absent (fine) from corrupt (a real, surfaceable fault). */
export type DiskRead =
  | { kind: "ok"; cookies: Record<string, string> }
  | { kind: "absent" }
  | { kind: "corrupt"; detail: string };

/** Browser read across installed browsers: a hit, a clean miss, or real errors. */
export type BrowserAttempt =
  | { kind: "ok"; cookies: Record<string, string> }
  | { kind: "none" }
  | { kind: "error"; reasons: CookieReason[] };

/**
 * Injectable acquisition sources. The default wires the real fs / browser DB /
 * CDP; tests pass fakes so the whole policy is verifiable without a network,
 * Keychain, or browser.
 */
export interface CookieSources {
  readDisk(site: string): DiskRead;
  readBrowser(domain: string): Promise<BrowserAttempt>;
  readCdp(domain: string): Promise<Record<string, string>>;
}

const SITE_RE = /^[a-zA-Z0-9._-]+$/;

export function cookieDir(): string {
  return (
    process.env.UNICLI_COOKIE_DIR ??
    join(process.env.HOME ?? "~", ".unicli", "cookies")
  );
}

/**
 * Read the on-disk cookie file, distinguishing absent from corrupt. The old
 * loadCookies collapsed a truncated / wrong-shaped file to null ("no auth"),
 * hiding the real cause; this returns a typed corrupt with a detail.
 */
export function readDiskCookies(site: string): DiskRead {
  if (!SITE_RE.test(site)) {
    return { kind: "corrupt", detail: `invalid site name "${site}"` };
  }
  const path = join(cookieDir(), `${site}.json`);
  if (!existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return {
      kind: "corrupt",
      detail: `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: `${path} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "corrupt", detail: `${path} is not a {name: value} object` };
  }
  return { kind: "ok", cookies: parsed as Record<string, string> };
}

/** Resolve the cookie domain the same way the legacy loader did. */
export function resolveCookieDomain(site: string, domain?: string): string {
  let resolved = domain ?? site.replace(/_/g, ".");
  if (!resolved.includes(".")) resolved = `${resolved}.com`;
  return resolved;
}

async function defaultReadBrowser(domain: string): Promise<BrowserAttempt> {
  let mod: typeof import("./chromium-cookies.js");
  let localProfiles: typeof import("../browser/local-profiles.js");
  try {
    [mod, localProfiles] = await Promise.all([
      import("./chromium-cookies.js"),
      import("../browser/local-profiles.js"),
    ]);
  } catch (err) {
    return {
      kind: "error",
      reasons: [
        {
          source: "browser",
          code: "module_load_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  const reasons: CookieReason[] = [];
  const preferred = localProfiles.resolvePreferredLocalBrowserProfile();
  if (preferred) {
    const preferredBrowser =
      localProfiles.browserCookieIdForLocalProfile(preferred);
    if (preferredBrowser) {
      try {
        const record = mod.readCookiesAsRecord({
          browser: preferredBrowser,
          domain,
          profile: preferred.profile_dir,
          userDataDir: preferred.user_data_dir,
        });
        if (Object.keys(record).length > 0) {
          return { kind: "ok", cookies: record };
        }
      } catch (err) {
        const code =
          err instanceof mod.ChromiumCookieError
            ? err.code
            : "browser_read_failed";
        reasons.push({
          source: "browser",
          code,
          detail: `${preferred.display_name}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }
  const installed = mod.detectInstalledBrowsers();
  if (installed.length === 0) return { kind: "none" };
  for (const browser of installed) {
    try {
      const record = mod.readCookiesAsRecord({ browser, domain });
      if (Object.keys(record).length > 0)
        return { kind: "ok", cookies: record };
    } catch (err) {
      const code =
        err instanceof mod.ChromiumCookieError
          ? err.code
          : "browser_read_failed";
      reasons.push({
        source: "browser",
        code,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reasons.length > 0 ? { kind: "error", reasons } : { kind: "none" };
}

async function defaultReadCdp(domain: string): Promise<Record<string, string>> {
  const { extractCookiesViaCDP } = await import("./cookie-extractor.js");
  return extractCookiesViaCDP(domain);
}

export const defaultCookieSources: CookieSources = {
  readDisk: readDiskCookies,
  readBrowser: defaultReadBrowser,
  readCdp: defaultReadCdp,
};

/**
 * Acquire cookies across disk, local browser storage, and live CDP, collecting
 * the real cause of each source's failure. Challenge recovery can prefer CDP
 * because the shared browser is where verification was just completed; normal
 * auth acquisition preserves the legacy browser-before-CDP order.
 *
 * Domain precedence and the default disk / browser / CDP order match the
 * legacy loadCookiesWithCDP behavior.
 */
export async function loadCookiesWithDiagnostics(
  site: string,
  domain?: string,
  sources: CookieSources = defaultCookieSources,
  opts: { skipDisk?: boolean; preferCdp?: boolean } = {},
): Promise<CookieLoadOutcome> {
  const reasons: CookieReason[] = [];

  // Refresh-after-401 skips disk: the on-disk cookies are exactly the stale
  // ones that just failed, so re-acquisition must go straight to the live
  // browser / CDP sources.
  if (!opts.skipDisk) {
    const disk = sources.readDisk(site);
    if (disk.kind === "ok") {
      return { status: "loaded", source: "disk", cookies: disk.cookies };
    }
    if (disk.kind === "corrupt") {
      reasons.push({
        source: "disk",
        code: "corrupt_file",
        detail: disk.detail,
      });
    }
  }

  const cookieDomain = resolveCookieDomain(site, domain);

  const order: CookieSourceName[] = opts.preferCdp
    ? ["cdp", "browser"]
    : ["browser", "cdp"];
  for (const source of order) {
    if (source === "browser") {
      if (process.env.UNICLI_COOKIE_NO_BROWSER === "1") continue;
      const browser = await sources.readBrowser(cookieDomain);
      if (browser.kind === "ok" && Object.keys(browser.cookies).length > 0) {
        return {
          status: "loaded",
          source: "browser",
          cookies: browser.cookies,
        };
      }
      if (browser.kind === "error") reasons.push(...browser.reasons);
      continue;
    }

    try {
      const cdp = await sources.readCdp(cookieDomain);
      if (Object.keys(cdp).length > 0) {
        return { status: "loaded", source: "cdp", cookies: cdp };
      }
    } catch (err) {
      reasons.push({
        source: "cdp",
        code: "cdp_unavailable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return reasons.length > 0
    ? { status: "error", reasons }
    : { status: "absent" };
}

/**
 * Turn a non-loaded outcome into an agent-actionable message + suggestion.
 * This is where the no-silent-failure win is spent: Keychain denial, v20
 * encryption, and a corrupt file each get a DISTINCT next step instead of the
 * legacy one-size-fits-all "run unicli auth setup".
 */
export function describeCookieFailure(
  outcome: Exclude<CookieLoadOutcome, { status: "loaded" }>,
  site: string,
  domain?: string,
): { message: string; suggestion: string; retryable: boolean } {
  const d = resolveCookieDomain(site, domain);
  if (outcome.status === "absent") {
    return {
      message: `No cookies found for "${site}".`,
      suggestion: `Sign in to https://${d} in Chrome, then run: unicli auth import ${site} --domain ${d}`,
      retryable: false,
    };
  }
  const codes = outcome.reasons.map((r) => `${r.source}:${r.code}`).join(", ");
  const has = (code: string) => outcome.reasons.some((r) => r.code === code);
  let suggestion: string;
  if (has("keychain_denied")) {
    suggestion = `Chrome cookie decryption was denied by the macOS Keychain. Grant access when prompted, or run: unicli auth import ${site} --domain ${d}`;
  } else if (has("encryption_unsupported")) {
    suggestion = `Chrome's app-bound encryption (v20) blocks direct cookie reads. Start Chrome via "unicli browser start" (CDP path), or run: unicli auth import ${site} --domain ${d}`;
  } else if (has("corrupt_file")) {
    suggestion = `The saved cookie file is unreadable. Re-import: unicli auth import ${site} --domain ${d}`;
  } else {
    suggestion = `Could not acquire cookies (${codes}). Sign in to https://${d}, then run: unicli auth import ${site} --domain ${d}`;
  }
  return {
    message: `Failed to load cookies for "${site}" — ${codes}.`,
    suggestion,
    retryable: false,
  };
}
