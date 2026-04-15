import type { PipelineContext } from "../executor.js";
import type { BrowserPage } from "../../browser/page.js";

/**
 * Lazily acquire a BrowserPage. Connects on first use and caches on ctx.
 *
 * Tries direct CDP first (fastest), then daemon (reuses Chrome login
 * sessions via extension), then auto-launches Chrome with a debug port as
 * the last resort. All imports stay dynamic so non-browser pipelines never
 * pay the load cost.
 */
export async function acquirePage(ctx: PipelineContext): Promise<BrowserPage> {
  if (ctx.page) return ctx.page;

  let port = 9222;
  const rawPort = process.env.UNICLI_CDP_PORT;
  if (rawPort) {
    const p = parseInt(rawPort, 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      port = p;
    }
  }

  // 1. Direct CDP first
  try {
    const { BrowserPage: BP } = await import("../../browser/page.js");
    const { injectStealth } = await import("../../browser/stealth.js");
    const page = await BP.connect(port);
    await injectStealth(page.sendCDP.bind(page));
    return page;
  } catch {
    /* CDP not available — try daemon */
  }

  // 2. Daemon fallback
  try {
    const { checkDaemonStatus } = await import("../../browser/discover.js");
    const status = await checkDaemonStatus({ timeout: 300 });
    if (status.running && status.extensionConnected) {
      const { BrowserBridge } = await import("../../browser/bridge.js");
      const bridge = new BrowserBridge();
      const page = await bridge.connect({ timeout: 5000 });
      return page as unknown as BrowserPage;
    }
  } catch {
    /* daemon not available either */
  }

  // 3. Auto-launch Chrome
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
