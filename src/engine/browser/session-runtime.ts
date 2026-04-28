import type { IPage } from "../../types.js";
import {
  BrowserSessionLeaseGuardError,
  type BrowserSessionLease,
  type BrowserSessionLeaseAuthPosture,
  type BrowserSessionLeaseTarget,
} from "./session-lease.js";

type BrowserTargetInfoProvider = {
  browserTargetInfo?: () => Promise<BrowserSessionLeaseTarget | null>;
};

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

  const current = await captureBrowserSessionTarget(page);
  const actual = browserSessionTargetKey(current);
  if (!actual || actual === expected) return;

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
): Promise<BrowserSessionLeaseTarget | undefined> {
  const provided = await captureProvidedBrowserTarget(page, now);
  if (provided) return provided;

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
  } catch {
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
): Promise<BrowserSessionLeaseTarget | undefined> {
  const provider = page as IPage & BrowserTargetInfoProvider;
  if (typeof provider.browserTargetInfo !== "function") return undefined;

  const target = await provider.browserTargetInfo().catch(() => null);
  if (!target) return undefined;
  return {
    ...target,
    captured_at: target.captured_at ?? now().toISOString(),
  };
}
