import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrowserBridge } from "../../src/browser/bridge.js";
import { syncLocalProfileCookiesToPage } from "../../src/browser/auth-sync.js";
import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  currentBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";
import { selectLocalBrowserIdentity } from "../../src/browser/local-profiles.js";
import {
  readCookiesAsRecord,
  ChromiumCookieError,
} from "../../src/engine/chromium-cookies.js";
import { extractCookiesViaCDP } from "../../src/engine/cookie-extractor.js";
import {
  defaultCookieSources,
  loadCookiesWithDiagnostics,
} from "../../src/engine/cookie-source.js";
import {
  readDiskCookies,
  saveCookies,
} from "../../src/engine/cookie-storage.js";
import {
  acquireCookies,
  refreshCookiesFromBrowser,
  runWithCookieInvocationOverride,
} from "../../src/engine/cookies.js";
import type { IPage } from "../../src/types.js";

const originalEnv = { ...process.env };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalConnect = BrowserBridge.prototype.connect;
const home = mkdtempSync(join(tmpdir(), "unicli-credential-reuse-"));
const failures: string[] = [];
const skipped: string[] = [];
let observations = 0;
const observe = (ok: boolean, label: string): void => {
  observations += 1;
  if (!ok) failures.push(label);
};
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.UNICLI_COOKIE_DIR = join(home, "cookies");
process.env.UNICLI_SKIP_UPDATE_CHECK = "1";
delete process.env.UNICLI_COOKIE_NO_BROWSER;
delete process.env.UNICLI_BROWSER_PROFILE_ID;

const root = join(home, "Library", "Application Support", "Google", "Chrome");
const profile = "google-chrome:Default";
const url = "https://api.example.test/api/items";
const databases: DatabaseSync[] = [];
function createProfile(name: string): DatabaseSync {
  const dir = join(root, name, "Network");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "Cookies"));
  databases.push(db);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB, value TEXT, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, is_persistent INTEGER, has_expires INTEGER);`);
  return db;
}
function addCookie(
  db: DatabaseSync,
  host: string,
  name: string,
  value: string,
  path = "/",
  expires = 0,
  encrypted = Buffer.alloc(0),
  secure = 1,
): void {
  db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    host,
    name,
    encrypted,
    value,
    path,
    expires,
    secure,
    1,
    expires ? 1 : 0,
    expires ? 1 : 0,
  );
}

try {
  let sqliteAvailable = true;
  try {
    execFileSync(process.env.UNICLI_SQLITE_BIN ?? "sqlite3", ["-version"], {
      stdio: "ignore",
    });
  } catch {
    sqliteAvailable = false;
    skipped.push(
      "SQLite profile scenarios require sqlite3 or UNICLI_SQLITE_BIN",
    );
  }

  if (sqliteAvailable) {
    const db = createProfile("Default");
    addCookie(db, ".example.test", "session", "root-v1");
    addCookie(db, ".example.test", "session", "api-v1", "/api");
    addCookie(db, "example.test", "parent_host_only", "excluded");
    addCookie(db, "api.example.test", "host_only", "included");
    addCookie(db, ".example.test", "wrong_path", "excluded", "/apiary");
    addCookie(db, ".unrelated.test", "unrelated", "excluded");
    addCookie(db, ".example.test", "encoded", "a|b\nc");
    addCookie(
      db,
      ".example.test",
      "expired",
      "excluded",
      "/",
      (Date.now() / 1000 - 60 + 11_644_473_600) * 1_000_000,
      Buffer.from("v20expired"),
    );
    addCookie(db, ".x.com", "auth_token", "synthetic-import");
    addCookie(db, ".x.com", "ct0", "synthetic-csrf");

    let outcome = await acquireCookies("example", "api.example.test", { url });
    observe(
      outcome.status === "loaded" &&
        outcome.source === "browser" &&
        outcome.cookies.session === "api-v1",
      "auto reads committed WAL login state from the only profile",
    );
    if (outcome.status === "loaded") {
      observe(
        outcome.cookies.host_only === "included" &&
          !outcome.cookies.parent_host_only &&
          !outcome.cookies.wrong_path &&
          !outcome.cookies.unrelated &&
          !outcome.cookies.expired,
        "request domain, path and expiry scope",
      );
      observe(
        outcome.cookies.encoded === "a|b\nc",
        "SQLite text preserves separators and newlines",
      );
    }
    observe(
      !existsSync(join(home, "cookies", "example.json")),
      "automatic browser reads stay in memory",
    );
    saveCookies("example", {});
    outcome = await acquireCookies("example", "api.example.test", { url });
    observe(
      outcome.status === "loaded" && outcome.source === "browser",
      "empty persisted records allow automatic acquisition",
    );
    writeFileSync(join(home, "cookies", "example.json"), "{broken");
    outcome = await acquireCookies("example", "api.example.test", { url });
    observe(
      outcome.status === "loaded" && outcome.source === "browser",
      "corrupt persisted records recover through the selected profile",
    );
    outcome = await acquireCookies("example", "api.example.test", {
      source: "disk",
    });
    observe(
      outcome.status === "error" && outcome.reasons[0].code === "corrupt_file",
      "explicit disk keeps its single-source failure",
    );

    db.prepare(
      "UPDATE cookies SET value=? WHERE name='session' AND path='/api'",
    ).run("api-v2");
    saveCookies("example", { session: "persisted-old" });
    const refresh = await refreshCookiesFromBrowser(
      "example",
      "api.example.test",
      { url },
    );
    observe(refresh.ok, "refresh reads newly committed WAL cookies");
    if (refresh.ok) {
      await runWithCookieInvocationOverride(
        refresh.invocation_override,
        async () => {
          const fresh = await acquireCookies("example", "api.example.test", {
            url,
          });
          observe(
            fresh.status === "loaded" && fresh.cookies.session === "api-v2",
            "one invocation consumes refreshed credentials",
          );
          const other = await acquireCookies("other", "api.example.test", {
            source: "disk",
          });
          observe(other.status === "absent", "the override remains site-bound");
        },
      );
      let replayRejected = false;
      try {
        await runWithCookieInvocationOverride(
          refresh.invocation_override,
          async () => undefined,
        );
      } catch {
        replayRejected = true;
      }
      observe(replayRejected, "a consumed refresh handle cannot be reused");
    }
    outcome = await acquireCookies("example", "api.example.test", { url });
    observe(
      outcome.status === "loaded" &&
        outcome.cookies.session === "persisted-old",
      "refresh leaves explicit persistence unchanged",
    );
    const restart = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {acquireCookies} from './src/engine/cookies.ts'; const r=await acquireCookies('example','api.example.test',{source:'browser',url:${JSON.stringify(url)}}); console.log(JSON.stringify({fresh:r.status==='loaded'&&r.cookies.session==='api-v2'}));`,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    observe(
      restart.status === 0 && JSON.parse(restart.stdout.trim()).fresh === true,
      "a new process reads current WAL state",
    );

    const other = createProfile("Profile 1");
    addCookie(other, ".example.test", "session", "other-account", "/api");
    outcome = await acquireCookies("empty", "api.example.test", { url });
    observe(
      outcome.status === "error" &&
        outcome.reasons.some((reason) => reason.code === "profile_ambiguous"),
      "multiple profiles require an identity selection",
    );
    process.env.UNICLI_BROWSER_PROFILE_ID = profile;
    const selection = selectLocalBrowserIdentity();
    observe(
      selection.status === "selected" &&
        selection.profile.id === profile &&
        selection.source === "explicit",
      "profile selection reads the current process environment",
    );
    outcome = await acquireCookies("empty", "api.example.test", { url });
    observe(
      outcome.status === "loaded" && outcome.cookies.session === "api-v2",
      "environment profile reaches cookie acquisition",
    );
    outcome = await acquireCookies("empty", "api.example.test", {
      url,
      profileId: "google-chrome:Profile 1",
    });
    observe(
      outcome.status === "loaded" &&
        outcome.cookies.session === "other-account",
      "explicit profile overrides environment without probing another account",
    );
    const profileScope = createBrowserInvocationScope({
      context: createBrowserInvocationContext({ transport: "mcp-stdio" }),
      provider: "managed",
      profileId: "google-chrome:Profile 1",
    });
    await runBrowserInvocation(profileScope, async () => {
      const scoped = await acquireCookies("empty", "api.example.test", { url });
      observe(
        scoped.status === "loaded" &&
          scoped.cookies.session === "other-account",
        "trusted managed invocation selects its local credential profile",
      );
      const explicit = await acquireCookies("empty", "api.example.test", {
        url,
        profileId: profile,
      });
      observe(
        explicit.status === "loaded" && explicit.cookies.session === "api-v2",
        "explicit profile takes precedence over the managed invocation",
      );
      let injectedAccount = false;
      // REASON: the page command is the external browser boundary; selected-profile discovery and cookie DB reading stay real.
      const sync = await syncLocalProfileCookiesToPage(
        {
          sendCDP: async (method, params) => {
            if (method === "Network.setCookies")
              injectedAccount = (
                params?.cookies as Array<{ value: string }>
              ).some((cookie) => cookie.value === "other-account");
            return {};
          },
        },
        { domain: "api.example.test" },
      );
      observe(
        sync.status === "synced" &&
          sync.profile_id === "google-chrome:Profile 1" &&
          injectedAccount,
        "browser cookie bootstrap uses the same managed profile identity",
      );
    });
    process.env.UNICLI_BROWSER_PROFILE_ID = "missing-profile";
    outcome = await acquireCookies("empty", "api.example.test", { url });
    observe(
      outcome.status === "error" &&
        outcome.reasons.some((reason) => reason.code === "profile_unavailable"),
      "missing selected profile remains an actionable error",
    );
    process.env.UNICLI_BROWSER_PROFILE_ID = profile;
    process.env.UNICLI_COOKIE_NO_BROWSER = "1";
    outcome = await acquireCookies("empty", "api.example.test", { url });
    observe(
      outcome.status === "absent",
      "explicit browser disablement preserves disk-only behavior",
    );
    delete process.env.UNICLI_COOKIE_NO_BROWSER;

    const imported = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/main.ts",
        "auth",
        "import",
        "twitter",
        "-f",
        "json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const stored = readDiskCookies("twitter");
    observe(
      imported.status === 0 &&
        stored.kind === "ok" &&
        stored.cookies.auth_token === "synthetic-import",
      "real CLI import resolves adapter domain x.com and the selected profile",
    );
    observe(
      !imported.stdout.includes("synthetic-import") &&
        !imported.stderr.includes("synthetic-import"),
      "import reports names and counts without values",
    );

    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    addCookie(
      db,
      ".example.test",
      "app_bound",
      "",
      "/api",
      0,
      Buffer.from("v20encrypted"),
    );
    let appBound = false;
    try {
      readCookiesAsRecord({
        browser: "chrome",
        userDataDir: root,
        profile: "Default",
        domain: "api.example.test",
        url,
      });
    } catch (error) {
      appBound =
        error instanceof ChromiumCookieError &&
        error.code === "encryption_unsupported";
    }
    observe(appBound, "Windows v20 is classified before OS keystore access");
    Object.defineProperty(process, "platform", platform);
  }

  let calls = 0;
  const aborted = new AbortController();
  aborted.abort(new Error("credential acquisition canceled"));
  const sources = {
    ...defaultCookieSources,
    readBrowser: async () => {
      calls += 1;
      return { kind: "ok" as const, cookies: { session: "synthetic" } };
    },
  };
  let canceled = false;
  try {
    await loadCookiesWithDiagnostics("empty", "api.example.test", sources, {
      source: "browser",
      signal: aborted.signal,
    });
  } catch (error) {
    canceled = error === aborted.signal.reason;
  }
  observe(
    canceled && calls === 0,
    "pre-canceled acquisition does no external read",
  );
  const during = new AbortController();
  canceled = false;
  try {
    await loadCookiesWithDiagnostics(
      "empty",
      "api.example.test",
      {
        ...sources,
        readBrowser: async () => {
          during.abort(new Error("stop after browser read"));
          return { kind: "ok", cookies: { session: "synthetic" } };
        },
      },
      { source: "browser", signal: during.signal },
    );
  } catch (error) {
    canceled = error === during.signal.reason;
  }
  observe(canceled, "cancellation after an external read propagates unchanged");

  const connects: Array<{
    provider?: string;
    visibility?: string;
    ambient?: string;
  }> = [];
  let closed = 0;
  let cdpReadFailed = false;
  let cdpCloseFailed = false;
  let cdpCancel: AbortController | undefined;
  let requestedUrls: unknown;
  // REASON: BrowserBridge.connect is the external browser boundary; acquisition, scope routing, cookie selection, cancellation and cleanup remain real.
  BrowserBridge.prototype.connect = async function (options) {
    connects.push({
      provider: options?.provider,
      visibility: options?.visibility,
      ambient: currentBrowserInvocationScope()?.provider,
    });
    return {
      sendCDP: async (_method: string, params?: Record<string, unknown>) => {
        requestedUrls = params?.urls;
        if (cdpReadFailed) throw new Error("synthetic CDP read failure");
        cdpCancel?.abort(new Error("CDP consumer canceled"));
        return {
          cookies: [
            {
              name: "session",
              value: "cdp-root",
              domain: ".example.test",
              path: "/",
              expires: -1,
              secure: true,
            },
            {
              name: "session",
              value: "cdp-api",
              domain: ".example.test",
              path: "/api",
              expires: -1,
              secure: true,
            },
            {
              name: "expired",
              value: "excluded",
              domain: ".example.test",
              path: "/",
              expires: 1,
              secure: true,
            },
            {
              name: "foreign",
              value: "excluded",
              domain: ".unrelated.test",
              path: "/",
              expires: -1,
              secure: true,
            },
          ],
        };
      },
      close: async () => {
        closed += 1;
        if (cdpCloseFailed) throw new Error("synthetic CDP close failure");
      },
    } as unknown as IPage;
  };
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const native = await acquireCookies("example", "api.example.test", {
    source: "cdp",
    url,
  });
  observe(
    native.status === "loaded" &&
      native.source === "cdp" &&
      native.cookies.session === "cdp-api" &&
      Object.keys(native.cookies).length === 1,
    "explicit CDP uses request-scoped browser cookies",
  );
  observe(
    connects[0]?.provider === "chrome" &&
      connects[0]?.visibility === "background" &&
      closed === 1,
    "Windows explicit CDP uses the native Chrome provider and releases its target",
  );
  observe(
    JSON.stringify(requestedUrls) === JSON.stringify([url]),
    "CDP requests only the target URL",
  );
  const scope = createBrowserInvocationScope({
    context: createBrowserInvocationContext({ transport: "cli" }),
    provider: "remote",
    visibility: "hidden",
  });
  await runBrowserInvocation(scope, () =>
    extractCookiesViaCDP("api.example.test", undefined, url),
  );
  observe(
    connects[1]?.provider === undefined && connects[1]?.ambient === "remote",
    "existing browser invocation keeps its provider identity on Windows",
  );
  Object.defineProperty(process, "platform", platform);
  cdpCancel = new AbortController();
  canceled = false;
  try {
    await extractCookiesViaCDP(
      "api.example.test",
      undefined,
      url,
      cdpCancel.signal,
    );
  } catch (error) {
    canceled = error === cdpCancel.signal.reason;
  }
  observe(
    canceled && closed === 3,
    "canceled CDP extraction releases its client",
  );
  cdpCancel = undefined;
  cdpReadFailed = true;
  cdpCloseFailed = true;
  let aggregate = false;
  try {
    await extractCookiesViaCDP("api.example.test", undefined, url);
  } catch (error) {
    aggregate = error instanceof AggregateError && error.errors.length === 2;
  }
  observe(
    aggregate && closed === 4,
    "read and cleanup failures retain both causes",
  );
  console.log(JSON.stringify({ observations, skipped, failures }, null, 2));
} finally {
  BrowserBridge.prototype.connect = originalConnect;
  Object.defineProperty(process, "platform", platform);
  for (const db of databases) db.close();
  for (const key of Object.keys(process.env))
    if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  rmSync(home, { recursive: true, force: true });
}
if (failures.length > 0) process.exitCode = 1;
