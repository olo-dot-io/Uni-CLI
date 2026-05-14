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
  } else if (ctx.browserSession !== "cdp") {
    const daemonPage = await acquireConnectedDaemonPage();
    if (daemonPage) return daemonPage;
  }

  let port = 9222;
  const rawPort = process.env.UNICLI_CDP_PORT;
  if (rawPort) {
    const p = parseInt(rawPort, 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      port = p;
    }
  }

  try {
    const { BrowserPage: BP } = await import("../../browser/page.js");
    const { injectStealth } = await import("../../browser/stealth.js");
    const page = await BP.connect(port);
    await injectStealth(page.sendCDP.bind(page));
    return page;
  } catch {
    // REASON: Browser acquisition has ordered transports; CDP failure falls through to auto-start Chrome.
  }
  try {
    const { launchChrome } = await import("../../browser/launcher.js");
    const { BrowserPage: BP } = await import("../../browser/page.js");
    const { injectStealth } = await import("../../browser/stealth.js");
    await launchChrome(port);
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
    return page;
  } catch (err) {
    throw new Error(
      `Cannot connect to Chrome. Run "unicli browser start" first. (${err instanceof Error ? err.message : String(err)})`,
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
