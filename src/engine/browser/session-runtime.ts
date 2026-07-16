/**
 * @owner       src/engine/browser/session-runtime.ts
 * @does        Capture browser target/auth evidence and enforce immutable lease target identity at the command boundary.
 * @needs       src/types.ts IPage, src/engine/browser/session-lease.ts
 * @feeds       src/commands/browser/actions.ts and browser action evidence
 * @breaks      BrowserSessionLeaseGuardError when authoritative target evidence is unavailable or differs from a leased target.
 * @invariants  Evidence enrichment is best-effort; lease enforcement is authoritative and fail-closed; a cached connected-target hint never proves current identity after transport failure.
 * @side-effects Reads target metadata and cookies from the active page.
 * @perf        At most one provider probe plus one CDP fallback per capture.
 * @concurrency Capture calls are independent and do not mutate page ownership.
 * @test        tests/unit/browser-session-runtime.test.ts, tests/unit/browser-page.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import type { IPage } from "../../types.js";
import {
  BrowserSessionLeaseGuardError,
  type BrowserSessionLease,
  type BrowserSessionLeaseAuthPosture,
  type BrowserSessionLeaseTarget,
} from "./session-lease.js";

type BrowserTargetInfoProvider = {
  browserTargetInfo?: (options?: {
    authoritative?: boolean;
  }) => Promise<BrowserSessionLeaseTarget | null>;
};

interface ProvidedBrowserTargetCapture {
  supported: boolean;
  target?: BrowserSessionLeaseTarget;
}

interface CdpTargetInfoResult {
  targetInfo?: {
    targetId?: string;
    type?: string;
    url?: string;
    title?: string;
  };
}

export async function enrichBrowserSessionLease(
  lease: BrowserSessionLease,
  page: IPage,
  options: { now?: () => Date } = {},
): Promise<BrowserSessionLease> {
  const now = options.now ?? (() => new Date());
  const [target, auth] = await Promise.all([
    captureBrowserSessionTarget(page, now),
    captureBrowserSessionAuthPosture(page, now),
  ]);

  return {
    ...lease,
    ...(target ? { target } : {}),
    auth,
  };
}

export async function assertBrowserSessionLeaseTargetCurrent(
  lease: BrowserSessionLease,
  page: IPage,
): Promise<void> {
  const expected = browserSessionTargetKey(lease.target);
  if (!expected) return;

  let current: BrowserSessionLeaseTarget | undefined;
  try {
    current = await captureBrowserSessionTarget(page, () => new Date(), {
      authoritative: true,
    });
  } catch {
    throw new BrowserSessionLeaseGuardError(
      "browser_target_unavailable",
      lease,
      expected,
      "unavailable",
    );
  }
  const actual = browserSessionTargetKey(current);
  if (!actual) {
    throw new BrowserSessionLeaseGuardError(
      "browser_target_unavailable",
      lease,
      expected,
      "unavailable",
    );
  }
  if (actual === expected) return;

  throw new BrowserSessionLeaseGuardError(
    "browser_target_mismatch",
    lease,
    expected,
    actual,
  );
}

export async function captureBrowserSessionTarget(
  page: IPage,
  now: () => Date = () => new Date(),
  options: { authoritative?: boolean } = {},
): Promise<BrowserSessionLeaseTarget | undefined> {
  const provided = await captureProvidedBrowserTarget(page, now, options);
  if (provided.target) return provided.target;
  if (provided.supported && options.authoritative) return undefined;

  try {
    const raw = (await page.sendCDP("Target.getTargetInfo")) as
      | CdpTargetInfoResult
      | undefined;
    const info = raw?.targetInfo;
    if (!info) return undefined;
    return {
      kind: "cdp-target",
      captured_at: now().toISOString(),
      ...(info.targetId ? { target_id: info.targetId } : {}),
      ...(info.type ? { target_type: info.type } : {}),
      ...(info.url ? { url: info.url } : {}),
      ...(info.title ? { title: info.title } : {}),
    };
  } catch (error) {
    if (options.authoritative) throw error;
    return undefined;
  }
}

export async function captureBrowserSessionAuthPosture(
  page: IPage,
  now: () => Date = () => new Date(),
): Promise<BrowserSessionLeaseAuthPosture> {
  try {
    const cookies = await page.cookies();
    const cookieCount = Object.keys(cookies).length;
    return {
      state: cookieCount > 0 ? "cookies_present" : "no_cookies",
      cookie_count: cookieCount,
      captured_at: now().toISOString(),
    };
  } catch {
    return {
      state: "unavailable",
      captured_at: now().toISOString(),
    };
  }
}

export function browserSessionTargetKey(
  target?: BrowserSessionLeaseTarget | null,
): string | undefined {
  if (!target) return undefined;
  if (typeof target.tab_id === "number") {
    return typeof target.window_id === "number"
      ? `window:${String(target.window_id)}:tab:${String(target.tab_id)}`
      : `tab:${String(target.tab_id)}`;
  }
  if (target.target_id) return `target:${target.target_id}`;
  return undefined;
}

async function captureProvidedBrowserTarget(
  page: IPage,
  now: () => Date,
  options: { authoritative?: boolean },
): Promise<ProvidedBrowserTargetCapture> {
  const provider = page as IPage & BrowserTargetInfoProvider;
  if (typeof provider.browserTargetInfo !== "function") {
    return { supported: false };
  }

  try {
    const target = await provider.browserTargetInfo({
      authoritative: options.authoritative === true,
    });
    if (!target) return { supported: true };
    return {
      supported: true,
      target: {
        ...target,
        captured_at: target.captured_at ?? now().toISOString(),
      },
    };
  } catch (error) {
    if (options.authoritative) throw error;
    return { supported: true };
  }
}
