import { createHash } from "node:crypto";

export type BrowserSessionLeaseScope = "shared" | "explicit" | "isolated";

export interface BrowserSessionLeaseOptions {
  namespace: "browser" | "operate";
  workspace: string;
  isolated?: boolean;
  sharedSession?: boolean;
  daemonPort?: string;
  expectedDomain?: string;
  expectedPathPrefix?: string;
}

export interface BrowserSessionLease {
  browser_session_id: string;
  browser_workspace_id: string;
  lease_owner: string;
  scope: BrowserSessionLeaseScope;
  daemon_port?: string;
  url_guard?: BrowserSessionLeaseUrlGuard;
}

export interface BrowserSessionLeaseUrlGuard {
  expected_domain?: string;
  expected_path_prefix?: string;
}

export class BrowserSessionLeaseGuardError extends Error {
  suggestion =
    "Bind or open a tab that matches the requested browser lease guard.";

  constructor(
    readonly code: "browser_domain_mismatch" | "browser_path_mismatch",
    readonly lease: BrowserSessionLease,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      code === "browser_domain_mismatch"
        ? `Browser tab hostname "${actual}" does not match expected domain "${expected}"`
        : `Browser tab path "${actual}" does not match expected path prefix "${expected}"`,
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
  const daemonPort = normalizedDaemonPort(options.daemonPort);
  const urlGuard = browserSessionLeaseUrlGuard(options);

  return {
    browser_session_id: `browser-session:${shortHash([
      "v1",
      owner,
      workspace,
      daemonPort ?? "default-daemon",
    ])}`,
    browser_workspace_id: workspace,
    lease_owner: owner,
    scope,
    ...(daemonPort ? { daemon_port: daemonPort } : {}),
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
  if (options.sharedSession || workspace === `${options.namespace}:default`) {
    return "shared";
  }
  return "explicit";
}

function normalizedDaemonPort(value?: string): string | undefined {
  const raw = value ?? process.env.UNICLI_DAEMON_PORT;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
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
