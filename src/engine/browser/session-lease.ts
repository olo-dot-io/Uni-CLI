/**
 * @owner       src/engine/browser/session-lease.ts
 * @does        Describe browser evidence leases and enforce exact domain/path/target guards independently of the runtime transport.
 * @needs       node:crypto
 * @feeds       src/commands/browser/actions.ts, src/engine/browser/session-runtime.ts, browser action evidence
 * @breaks      BrowserSessionLeaseGuardError on domain, path, or target drift.
 * @invariants  Domain matching is exact-host or subdomain only; paths are prefix-matched; captured target identity is immutable evidence.
 * @side-effects none
 * @perf        O(length of guard and captured target strings).
 * @concurrency Pure value construction and validation.
 * @test        tests/unit/browser-session-lease.test.ts, tests/unit/browser-action-evidence.test.ts
 * @stability   experimental
 * @since       2026-05-14
 */

import { createHash } from "node:crypto";

export type BrowserSessionLeaseScope = "shared" | "explicit" | "isolated";

export interface BrowserSessionLeaseOptions {
  namespace: "browser" | "operate";
  workspace: string;
  isolated?: boolean;
  expectedDomain?: string;
  expectedPathPrefix?: string;
}

export interface BrowserSessionLease {
  browser_session_id: string;
  browser_workspace_id: string;
  lease_owner: string;
  scope: BrowserSessionLeaseScope;
  url_guard?: BrowserSessionLeaseUrlGuard;
  target?: BrowserSessionLeaseTarget;
  auth?: BrowserSessionLeaseAuthPosture;
}

export interface BrowserSessionLeaseUrlGuard {
  expected_domain?: string;
  expected_path_prefix?: string;
}

export interface BrowserSessionLeaseTarget {
  kind: "broker-target" | "cdp-target" | "unknown";
  captured_at: string;
  target_id?: string;
  provider?: "managed" | "chrome" | "remote";
  visibility?: "hidden" | "background" | "foreground";
  tab_id?: number;
  window_id?: number;
  target_type?: string;
  url?: string;
  title?: string;
  owned?: boolean;
  preferred_tab_id?: number | null;
  tab_count?: number;
}

export interface BrowserSessionLeaseAuthPosture {
  state: "cookies_present" | "no_cookies" | "unavailable";
  captured_at: string;
  cookie_count?: number;
}

export class BrowserSessionLeaseGuardError extends Error {
  suggestion =
    "Bind or open a tab that matches the requested browser lease guard.";

  constructor(
    readonly code:
      | "browser_domain_mismatch"
      | "browser_path_mismatch"
      | "browser_target_mismatch",
    readonly lease: BrowserSessionLease,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      code === "browser_domain_mismatch"
        ? `Browser tab hostname "${actual}" does not match expected domain "${expected}"`
        : code === "browser_path_mismatch"
          ? `Browser tab path "${actual}" does not match expected path prefix "${expected}"`
          : `Browser target "${actual}" does not match expected target "${expected}"`,
    );
    this.name = "BrowserSessionLeaseGuardError";
  }
}

export function createBrowserSessionLease(
  options: BrowserSessionLeaseOptions,
): BrowserSessionLease {
  const workspace = options.workspace.trim();
  const owner = `unicli.${options.namespace}`;
  const scope = leaseScope(workspace, options);
  const urlGuard = browserSessionLeaseUrlGuard(options);

  return {
    browser_session_id: `browser-session:${shortHash([
      "v2",
      owner,
      workspace,
      "browser-runtime-broker",
    ])}`,
    browser_workspace_id: workspace,
    lease_owner: owner,
    scope,
    ...(urlGuard ? { url_guard: urlGuard } : {}),
  };
}

export function assertBrowserSessionLeaseUrlGuard(
  lease: BrowserSessionLease,
  currentUrl: string,
): void {
  if (!lease.url_guard) return;
  const url = new URL(currentUrl);
  const host = url.hostname.toLowerCase();
  const expectedDomain = lease.url_guard.expected_domain;
  if (expectedDomain && !matchesDomainGuard(host, expectedDomain)) {
    throw new BrowserSessionLeaseGuardError(
      "browser_domain_mismatch",
      lease,
      expectedDomain,
      host,
    );
  }

  const expectedPathPrefix = lease.url_guard.expected_path_prefix;
  if (expectedPathPrefix && !url.pathname.startsWith(expectedPathPrefix)) {
    throw new BrowserSessionLeaseGuardError(
      "browser_path_mismatch",
      lease,
      expectedPathPrefix,
      url.pathname,
    );
  }
}

function leaseScope(
  workspace: string,
  options: BrowserSessionLeaseOptions,
): BrowserSessionLeaseScope {
  if (options.isolated || /^browser:\d+:\d+:[0-9a-f]+$/.test(workspace)) {
    return "isolated";
  }
  if (workspace === `${options.namespace}:default` || workspace === "default") {
    return "shared";
  }
  return "explicit";
}

function browserSessionLeaseUrlGuard(
  options: BrowserSessionLeaseOptions,
): BrowserSessionLeaseUrlGuard | undefined {
  const expectedDomain = normalizedDomain(options.expectedDomain);
  const expectedPathPrefix = normalizedPathPrefix(options.expectedPathPrefix);
  if (!expectedDomain && !expectedPathPrefix) return undefined;
  return {
    ...(expectedDomain ? { expected_domain: expectedDomain } : {}),
    ...(expectedPathPrefix ? { expected_path_prefix: expectedPathPrefix } : {}),
  };
}

function normalizedDomain(value?: string): string | undefined {
  const normalized = value
    ?.trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizedPathPrefix(value?: string): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function matchesDomainGuard(host: string, expectedDomain: string): boolean {
  return host === expectedDomain || host.endsWith(`.${expectedDomain}`);
}

function shortHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 16);
}
