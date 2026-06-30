#!/usr/bin/env tsx
/**
 * @owner   scripts/browser-auth-default-acceptance.ts
 * @does    Verify Uni-CLI browser startup reuses logged-in browser state through live attach or seeded automation profiles.
 * @needs   src/browser/launcher.ts, src/browser/local-profiles.ts, src/browser/profile-seed.ts, src/engine/chromium-cookies.ts
 * @feeds   manual acceptance for default browser auth behavior
 * @breaks  Exits non-zero when profile discovery, launch, seed freshness, cookie decrypt, or persistent cookie equality checks fail.
 * @invariants Never prints cookie values; seeded success requires decrypted persistent cookie equality with the source profile; session drift is reported separately.
 * @side-effects May launch Chrome through Uni-CLI's launcher and may seed Uni-CLI-owned automation profiles.
 * @perf    Reads only the selected domain's cookies from copied SQLite snapshots.
 * @concurrency Relies on launcher/profile-seed locks; does not mutate real browser profiles.
 * @test    manual: npm run accept:browser-auth -- --domain <domain>
 * @stability experimental
 * @since   2026-06-29
 */

import process from "node:process";
import {
  automationDefaultUserDataDir,
  automationUserDataDirForProfile,
  isProcessVerifiedDebugPort,
  readUserDataDirDebugPort,
  resolvePreferredLocalBrowserProfile,
  type LocalBrowserProfile,
} from "../src/browser/local-profiles.js";
import {
  findAvailableCDPPort,
  getCDPPort,
  isCDPAvailable,
  launchChrome,
} from "../src/browser/launcher.js";
import {
  inspectAutomationProfileSeed,
  isRunningSeedIdentityUsable,
} from "../src/browser/profile-seed.js";
import {
  ChromiumCookieError,
  readCookies,
  type BrowserId,
  type CookieRow,
} from "../src/engine/chromium-cookies.js";

interface CliOptions {
  domain: string;
  profileId?: string;
  noStart: boolean;
  requireSeeded: boolean;
  json: boolean;
}

interface AcceptanceReport {
  ok: boolean;
  mode: "attach" | "seeded" | "unknown";
  domain: string;
  source_profile: {
    id: string;
    display_name: string;
    user_data_dir: string;
    profile_dir: string;
  };
  target_user_data_dir: string;
  port?: number;
  source_cookie_count: number;
  source_persistent_cookie_count: number;
  seeded_cookie_count?: number;
  seeded_persistent_cookie_count?: number;
  seed_status?: string;
  target_state?: unknown;
  persistent_mismatches?: string[];
  session_mismatches?: string[];
  mismatches?: string[];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const profile = resolvePreferredLocalBrowserProfile({
    profileId: opts.profileId,
  });
  if (!profile) {
    throw new Error(
      "No local browser profile found. Sign in to Chrome once or pass --profile-id from `unicli browser profiles --json`.",
    );
  }

  const browser = browserIdForProfile(profile);
  if (!browser) {
    throw new Error(
      `Cookie acceptance is not supported for ${profile.browser_name}; choose a Chromium browser supported by src/engine/chromium-cookies.ts.`,
    );
  }

  const targetUserDataDir = opts.profileId
    ? automationUserDataDirForProfile(profile)
    : automationDefaultUserDataDir();
  const sourceRows = readCookies({
    browser,
    domain: opts.domain,
    profile: profile.profile_dir,
    userDataDir: profile.user_data_dir,
  });
  if (sourceRows.length === 0) {
    throw new Error(
      `Source profile ${profile.display_name} has zero decrypted cookies for ${opts.domain}. Visit the site while signed in, then rerun.`,
    );
  }
  const sourcePersistentRows = persistentRows(sourceRows);
  if (sourcePersistentRows.length === 0) {
    throw new Error(
      `Source profile ${profile.display_name} has zero persistent decrypted cookies for ${opts.domain}. Chrome may only hold session cookies for this site; use a live-CDP E2E check instead of seeded snapshot equality.`,
    );
  }

  const sourceLivePort = await liveUserDataDirPort(profile.user_data_dir);
  let port: number | undefined;
  if (!opts.noStart) {
    const launchPort = await findAvailableCDPPort(getCDPPort());
    port = await launchChrome(
      launchPort,
      opts.profileId
        ? {
            seedProfile: profile,
            profileDirectory: profile.profile_dir,
          }
        : undefined,
    );
  }

  const seedState = inspectAutomationProfileSeed(profile, targetUserDataDir);
  const attached =
    sourceLivePort !== null && port !== undefined && port === sourceLivePort;
  if (attached) {
    if (opts.requireSeeded) {
      throw new Error(
        `Default startup attached to live source profile on port ${String(port)}; close that CDP browser or rerun without --require-seeded to accept the live attach path.`,
      );
    }
    printReport(opts, {
      ok: true,
      mode: "attach",
      domain: opts.domain,
      source_profile: describeProfile(profile),
      target_user_data_dir: targetUserDataDir,
      port,
      source_cookie_count: sourceRows.length,
      source_persistent_cookie_count: sourcePersistentRows.length,
      seed_status: seedState.status,
      target_state: seedState.target_state,
    });
    return;
  }

  if (!isRunningSeedIdentityUsable(seedState)) {
    throw new Error(
      `Automation profile seed is ${seedState.status}: ${seedWarningReason(seedState.reason)}.`,
    );
  }

  const seededRows = readCookies({
    browser,
    domain: opts.domain,
    profile: profile.profile_dir,
    userDataDir: targetUserDataDir,
  });
  const seededPersistentRows = persistentRows(seededRows);
  const persistentMismatches = compareCookieRows(
    sourcePersistentRows,
    seededPersistentRows,
  );
  const sessionMismatches = compareCookieRows(
    sessionRows(sourceRows),
    sessionRows(seededRows),
  );
  if (seededPersistentRows.length === 0 || persistentMismatches.length > 0) {
    printReport(opts, {
      ok: false,
      mode: "seeded",
      domain: opts.domain,
      source_profile: describeProfile(profile),
      target_user_data_dir: targetUserDataDir,
      port,
      source_cookie_count: sourceRows.length,
      source_persistent_cookie_count: sourcePersistentRows.length,
      seeded_cookie_count: seededRows.length,
      seeded_persistent_cookie_count: seededPersistentRows.length,
      seed_status: seedState.status,
      target_state: seedState.target_state,
      persistent_mismatches: persistentMismatches,
      session_mismatches: sessionMismatches,
      mismatches: persistentMismatches,
    });
    throw new Error(
      `Seeded automation profile persistent cookies do not match source profile for ${opts.domain}.`,
    );
  }

  printReport(opts, {
    ok: true,
    mode: "seeded",
    domain: opts.domain,
    source_profile: describeProfile(profile),
    target_user_data_dir: targetUserDataDir,
    port,
    source_cookie_count: sourceRows.length,
    source_persistent_cookie_count: sourcePersistentRows.length,
    seeded_cookie_count: seededRows.length,
    seeded_persistent_cookie_count: seededPersistentRows.length,
    seed_status: seedState.status,
    target_state: seedState.target_state,
    persistent_mismatches: persistentMismatches,
    session_mismatches: sessionMismatches,
  });
}

function parseArgs(args: string[]): CliOptions {
  let domain = "";
  let profileId: string | undefined;
  let noStart = false;
  let requireSeeded = false;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--domain") {
      domain = requireValue(args, ++index, "--domain");
    } else if (arg === "--profile-id") {
      profileId = requireValue(args, ++index, "--profile-id");
    } else if (arg === "--no-start") {
      noStart = true;
    } else if (arg === "--require-seeded") {
      requireSeeded = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!domain) {
    throw new Error("Missing required --domain <domain>.");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) {
    throw new Error(
      "Domain must contain only letters, digits, dots, and hyphens.",
    );
  }

  return { domain, profileId, noStart, requireSeeded, json };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  npm run accept:browser-auth -- --domain github.com [--profile-id google-chrome:Default]

Options:
  --domain <domain>      Domain whose decrypted cookies must match.
  --profile-id <id>     Profile from unicli browser profiles --json.
  --no-start            Inspect the existing automation profile without launching Chrome.
  --require-seeded      Fail if default startup attaches to a live source profile.
  --json                Print machine-readable JSON.`);
}

function browserIdForProfile(profile: LocalBrowserProfile): BrowserId | null {
  switch (profile.browser_name) {
    case "Google Chrome":
      return "chrome";
    case "Brave":
      return "brave";
    case "Microsoft Edge":
      return "edge";
    case "Arc":
      return "arc";
    case "Dia":
      return "dia";
    default:
      return null;
  }
}

async function liveUserDataDirPort(
  userDataDir: string,
): Promise<number | null> {
  const debugPort = readUserDataDirDebugPort(userDataDir);
  if (
    !isProcessVerifiedDebugPort(debugPort) ||
    typeof debugPort.port !== "number" ||
    !(await isCDPAvailable(debugPort.port))
  ) {
    return null;
  }
  return debugPort.port;
}

function describeProfile(
  profile: LocalBrowserProfile,
): AcceptanceReport["source_profile"] {
  return {
    id: profile.id,
    display_name: profile.display_name,
    user_data_dir: profile.user_data_dir,
    profile_dir: profile.profile_dir,
  };
}

function compareCookieRows(
  sourceRows: CookieRow[],
  seededRows: CookieRow[],
): string[] {
  const source = cookieMap(sourceRows);
  const seeded = cookieMap(seededRows);
  const mismatches: string[] = [];
  for (const [key, value] of source) {
    if (!seeded.has(key)) {
      mismatches.push(`missing:${key}`);
    } else if (seeded.get(key) !== value) {
      mismatches.push(`value:${key}`);
    }
  }
  for (const key of seeded.keys()) {
    if (!source.has(key)) mismatches.push(`extra:${key}`);
  }
  return mismatches;
}

function cookieMap(rows: CookieRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(`${row.host}\t${row.name}\t${row.path}`, row.value);
  }
  return out;
}

function persistentRows(rows: CookieRow[]): CookieRow[] {
  return rows.filter((row) => row.persistent);
}

function sessionRows(rows: CookieRow[]): CookieRow[] {
  return rows.filter((row) => !row.persistent);
}

function seedWarningReason(reason: string | undefined): string {
  return (reason ?? "manifest is not fresh").replace(/\.+$/, "");
}

function printReport(opts: CliOptions, report: AcceptanceReport): void {
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Browser auth acceptance: ${report.ok ? "ok" : "failed"}`);
  console.log(`Mode: ${report.mode}`);
  console.log(`Domain: ${report.domain}`);
  console.log(`Source: ${report.source_profile.display_name}`);
  console.log(`Target user-data-dir: ${report.target_user_data_dir}`);
  if (report.port !== undefined)
    console.log(`CDP port: ${String(report.port)}`);
  console.log(`Source cookie count: ${String(report.source_cookie_count)}`);
  console.log(
    `Source persistent cookie count: ${String(report.source_persistent_cookie_count)}`,
  );
  if (report.seeded_cookie_count !== undefined) {
    console.log(`Seeded cookie count: ${String(report.seeded_cookie_count)}`);
  }
  if (report.seeded_persistent_cookie_count !== undefined) {
    console.log(
      `Seeded persistent cookie count: ${String(report.seeded_persistent_cookie_count)}`,
    );
  }
  if (report.seed_status) console.log(`Seed status: ${report.seed_status}`);
  if (report.target_state) {
    console.log(`Target state: ${JSON.stringify(report.target_state)}`);
  }
  if (report.persistent_mismatches && report.persistent_mismatches.length > 0) {
    console.log(
      `Persistent mismatches: ${report.persistent_mismatches.slice(0, 20).join(", ")}`,
    );
  }
  if (report.session_mismatches && report.session_mismatches.length > 0) {
    console.log(
      `Session mismatches: ${report.session_mismatches.slice(0, 20).join(", ")}`,
    );
  }
  if (report.mismatches && report.mismatches.length > 0) {
    console.log(`Mismatches: ${report.mismatches.slice(0, 20).join(", ")}`);
  }
}

main().catch((err) => {
  const message =
    err instanceof ChromiumCookieError
      ? `${err.code}: ${err.message}${err.suggestion ? ` ${err.suggestion}` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  console.error(`Browser auth acceptance failed: ${message}`);
  process.exitCode = 1;
});
