/**
 * @owner       src/engine/steps/browser-helpers.ts
 * @does        Acquire one broker-backed page for pipeline steps, install browser hardening, and synchronize declared user-session cookies.
 * @needs       src/browser bridge/invocation-scope/stealth/auth-sync, src/engine/executor.ts, src/types.ts
 * @feeds       browser pipeline steps and adapter execution
 * @breaks      Broker, provider, stealth, and cookie bootstrap failures retain their exact owning error without transport fallback.
 * @invariants  Browser lifetime is broker-owned; a pipeline never probes or launches direct CDP; user-cookie injection is skipped for the existing-Chrome provider.
 * @side-effects May lazily start the broker/provider, install page scripts, inject cookies, and read network evidence.
 * @perf        First acquisition performs one broker session start and hardening; later pipeline steps reuse ctx.page.
 * @concurrency Agent identity comes from the async invocation scope and target ordering is broker-owned.
 * @test        tests/unit/browser-helpers-auth.test.ts, tests/unit/pipeline.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { BrowserBridge } from "../../browser/bridge.js";
import { currentBrowserInvocationScope } from "../../browser/invocation-scope.js";
import { injectStealth } from "../../browser/stealth.js";
import type { IPage } from "../../types.js";
import type { PipelineContext } from "../executor.js";

export async function acquirePage(ctx: PipelineContext): Promise<IPage> {
  if (ctx.page) return ctx.page;
  const bridge = new BrowserBridge();
  const page = await bridge.connect();
  await injectStealth(page.sendCDP.bind(page));
  await syncUserSessionCookies(page, ctx);
  return page;
}

async function syncUserSessionCookies(
  page: IPage,
  ctx: PipelineContext,
): Promise<void> {
  if (
    ctx.browserSession !== "user" ||
    currentBrowserInvocationScope()?.provider === "chrome"
  ) {
    return;
  }
  const { syncLocalProfileCookiesToPage } =
    await import("../../browser/auth-sync.js");
  const sync = await syncLocalProfileCookiesToPage(page, {
    site: ctx.site,
    domain: ctx.domain,
  });
  if (sync.status === "synced") return;
  const reason =
    sync.status === "failed"
      ? sync.reason
      : `${sync.reason}${sync.domain ? ` for ${sync.domain}` : ""}`;
  throw new Error(
    `Failed to bootstrap browser cookies for ${ctx.domain ?? ctx.site ?? "site"}: ${reason}`,
  );
}

export async function waitForNetworkIdle(
  page: IPage,
  maxMs = 5_000,
  quietMs = 500,
): Promise<void> {
  const startedAt = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const currentCount = (await page.networkRequests()).length;
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return;
    }
    await page.waitFor(100);
  }
}
