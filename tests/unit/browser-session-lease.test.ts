import { describe, expect, it } from "vitest";

import {
  BrowserSessionLeaseGuardError,
  assertBrowserSessionLeaseUrlGuard,
  createBrowserSessionLease,
} from "../../src/engine/browser/session-lease.js";

describe("browser session lease", () => {
  it("normalizes URL guard metadata into the lease", () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "profile-a",
      expectedDomain: " .Example.COM. ",
      expectedPathPrefix: "feed",
    });

    expect(lease.url_guard).toEqual({
      expected_domain: "example.com",
      expected_path_prefix: "/feed",
    });
  });

  it("accepts exact and subdomain URL guard matches", () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "profile-a",
      expectedDomain: "example.com",
      expectedPathPrefix: "/feed",
    });

    expect(() =>
      assertBrowserSessionLeaseUrlGuard(
        lease,
        "https://example.com/feed/today",
      ),
    ).not.toThrow();
    expect(() =>
      assertBrowserSessionLeaseUrlGuard(
        lease,
        "https://app.example.com/feed/today",
      ),
    ).not.toThrow();
  });

  it("rejects hostname boundary mismatches", () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "profile-a",
      expectedDomain: "example.com",
    });

    expect(() =>
      assertBrowserSessionLeaseUrlGuard(
        lease,
        "https://badexample.com/feed/today",
      ),
    ).toThrow(BrowserSessionLeaseGuardError);
    try {
      assertBrowserSessionLeaseUrlGuard(
        lease,
        "https://badexample.com/feed/today",
      );
    } catch (err) {
      expect(err).toMatchObject({
        code: "browser_domain_mismatch",
        lease,
        expected: "example.com",
        actual: "badexample.com",
      });
    }
  });

  it("rejects path-prefix mismatches", () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "profile-a",
      expectedPathPrefix: "/feed",
    });

    expect(() =>
      assertBrowserSessionLeaseUrlGuard(lease, "https://example.com/settings"),
    ).toThrow(BrowserSessionLeaseGuardError);
    try {
      assertBrowserSessionLeaseUrlGuard(lease, "https://example.com/settings");
    } catch (err) {
      expect(err).toMatchObject({
        code: "browser_path_mismatch",
        lease,
        expected: "/feed",
        actual: "/settings",
      });
    }
  });
});
