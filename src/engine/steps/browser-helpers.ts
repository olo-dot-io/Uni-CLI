/**
 * @owner   src/engine/steps/browser-helpers.ts
 * @does    Acquire browser pages for pipeline steps and bootstrap user-session cookies after transport selection.
 * @needs   src/browser bridge/page/launcher/stealth/local-profiles/auth-sync, src/engine/executor.ts
 * @feeds   browser pipeline steps, adapter execution, tests/unit/browser-helpers-auth.test.ts
 * @breaks  Browser acquisition and cookie bootstrap failures throw explicit command-facing errors.
 * @invariants User-session CDP startup delegates attach/seed/ephemeral policy to src/browser/launcher.ts.
 * @side-effects May start Chrome through launcher and may inject cookies into the connected page.
 * @perf    Daemon probes are bounded before CDP fallback; Chrome target polling is capped.
 * @concurrency Launcher owns automation profile seed locking and live-profile reuse.
 * @test    tests/unit/browser-helpers-auth.test.ts
 * @stability experimental
 * @since   2026-06-29
 */

import type { PipelineContext } from "../executor.js";
import type { BrowserPage } from "../../browser/page.js";

async function acquireDaemonPage(timeout: number): Promise<BrowserPage | null> {
  try {
    const { BrowserBridge } = await import("../../browser/bridge.js");
    const bridge = new BrowserBridge();
    return (await bridge.connect({ timeout })) as unknown as BrowserPage;
  } catch {
    // REASON: Browser acquisition has ordered transports; a failed daemon attempt is diagnosed by the final acquisition error.
    return null;
  }
}

async function acquireConnectedDaemonPage(): Promise<BrowserPage | null> {
  try {
    const { checkDaemonStatus } = await import("../../browser/discover.js");
    const status = await checkDaemonStatus({ timeout: 300 });
    if (!status.running || !status.extensionConnected) return null;
    return acquireDaemonPage(5000);
  } catch {
    // REASON: Browser acquisition has ordered transports; a failed daemon status probe only selects the next transport.
    return null;
  }
}

/**
 * Lazily acquire a BrowserPage.
 * User-session commands prefer Uni-CLI's daemon/extension bridge before CDP.
 */
export async function acquirePage(ctx: PipelineContext): Promise<BrowserPage> {
  if (ctx.page) return ctx.page;

  if (ctx.browserSession === "user") {
    const daemonPage =
      process.env.UNICLI_BROWSER_SPAWN_DAEMON === "1"
        ? await acquireDaemonPage(3000)
        : await acquireConnectedDaemonPage();
    if (daemonPage) return daemonPage;
    const userSessionPage = await acquireUserSessionCdpPage(ctx);
    if (userSessionPage) return userSessionPage;
  } else if (ctx.browserSession !== "cdp") {
    const daemonPage = await acquireConnectedDaemonPage();
    if (daemonPage) return daemonPage;
  }

  const { resolveCdpPort } = await import("../../browser/cdp-client.js");
  const port = resolveCdpPort();

  try {
    const { BrowserPage: BP } = await import("../../browser/page.js");
    const { injectStealth } = await import("../../browser/stealth.js");
    const page = await BP.connect(port);
    await injectStealth(page.sendCDP.bind(page));
    await syncUserSessionCookies(page, ctx);
    return page;
  } catch {
    // REASON: Browser acquisition has ordered transports; CDP failure falls through to auto-start Chrome.
  }
  try {
    const { launchChrome } = await import("../../browser/launcher.js");
    const { BrowserPage: BP } = await import("../../browser/page.js");
    const { injectStealth } = await import("../../browser/stealth.js");
    await launchChrome(port, await launchOptionsForContext(ctx));
    let page: BrowserPage | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        page = await BP.connect(port);
        break;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!page) throw new Error("Chrome launched but no page target available");
    await injectStealth(page.sendCDP.bind(page));
    await syncUserSessionCookies(page, ctx);
    return page;
  } catch (err) {
    throw new Error(
      `Cannot connect to Chrome. Run "unicli browser start" first. (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

async function acquireUserSessionCdpPage(
  ctx: PipelineContext,
): Promise<BrowserPage | null> {
  const {
    automationUserDataDirForProfile,
    resolvePreferredLocalBrowserProfile,
  } = await import("../../browser/local-profiles.js");
  const profile = resolvePreferredLocalBrowserProfile();
  if (!profile) return null;

  const { resolveCdpPort } = await import("../../browser/cdp-client.js");
  const { BrowserPage: BP } = await import("../../browser/page.js");
  const { injectStealth } = await import("../../browser/stealth.js");
  const { findAvailableCDPPort, launchChrome } =
    await import("../../browser/launcher.js");

  const userDataDir = automationUserDataDirForProfile(profile);
  const port = await findAvailableCDPPort(resolveCdpPort());

  const actualPort = await launchChrome(port, {
    ...(profile.browser_path_exists
      ? { browserPath: profile.browser_path }
      : {}),
    seedProfile: profile,
    userDataDir,
    profileDirectory: profile.profile_dir,
    reuseExisting: false,
  });

  const page = await BP.connect(actualPort, { freshPage: true });
  await injectStealth(page.sendCDP.bind(page));
  await syncUserSessionCookies(page, ctx);
  return page;
}

async function launchOptionsForContext(
  ctx: PipelineContext,
): Promise<
  Parameters<typeof import("../../browser/launcher.js").launchChrome>[1]
> {
  if (ctx.browserSession !== "user") return undefined;

  const {
    automationUserDataDirForProfile,
    resolvePreferredLocalBrowserProfile,
  } = await import("../../browser/local-profiles.js");
  const profile = resolvePreferredLocalBrowserProfile();
  if (!profile) return undefined;

  return {
    ...(profile.browser_path_exists
      ? { browserPath: profile.browser_path }
      : {}),
    seedProfile: profile,
    userDataDir: automationUserDataDirForProfile(profile),
    profileDirectory: profile.profile_dir,
  };
}

async function syncUserSessionCookies(
  page: BrowserPage,
  ctx: PipelineContext,
): Promise<void> {
  if (ctx.browserSession !== "user") return;
  const { syncLocalProfileCookiesToPage } =
    await import("../../browser/auth-sync.js");
  const sync = await syncLocalProfileCookiesToPage(page, {
    site: ctx.site,
    domain: ctx.domain,
  });
  if (sync.status !== "synced") {
    const reason =
      sync.status === "failed"
        ? sync.reason
        : `${sync.reason}${sync.domain ? ` for ${sync.domain}` : ""}`;
    throw new Error(
      `Failed to bootstrap browser cookies for ${ctx.domain ?? ctx.site ?? "site"}: ${reason}`,
    );
  }
}

/**
 * Wait until no new network requests occur for quietMs.
 * Uses polling — checks page.networkRequests() count stability.
 */
export async function waitForNetworkIdle(
  page: BrowserPage,
  maxMs = 5000,
  quietMs = 500,
): Promise<void> {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();

  while (Date.now() - start < maxMs) {
    const requests = await page.networkRequests();
    const currentCount = requests.length;

    if (currentCount !== lastCount) {
      lastCount = currentCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }

    await page.waitFor(100);
  }
}
