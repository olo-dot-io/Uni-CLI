import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserSessionLease } from "../../src/engine/browser/session-lease.js";
import {
  BrowserSessionLeaseLockError,
  browserSessionLeaseLockPath,
  withBrowserSessionLeaseLock,
} from "../../src/engine/browser/session-lock.js";

describe("browser session lease lock", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-browser-lock-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates an exclusive lock for the lease and removes it after success", async () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
    });
    const lockPath = browserSessionLeaseLockPath(lease, tmp);

    await withBrowserSessionLeaseLock(
      lease,
      async () => {
        expect(existsSync(lockPath)).toBe(true);
        const payload = JSON.parse(readFileSync(lockPath, "utf-8")) as {
          browser_session_id: string;
        };
        expect(payload.browser_session_id).toBe(lease.browser_session_id);
        return "done";
      },
      { rootDir: tmp },
    );

    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails fast when the lease is already locked", async () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
    });

    await expect(
      withBrowserSessionLeaseLock(
        lease,
        async () =>
          await withBrowserSessionLeaseLock(lease, async () => "nested", {
            rootDir: tmp,
          }),
        { rootDir: tmp, retryMs: 0 },
      ),
    ).rejects.toMatchObject({
      code: "browser_lease_locked",
      lease,
    });
  });

  it("replaces a stale lock before running the action", async () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
    });
    const lockPath = browserSessionLeaseLockPath(lease, tmp);
    writeFileSync(lockPath, JSON.stringify({ stale: true }));

    const result = await withBrowserSessionLeaseLock(
      lease,
      async () => "recovered",
      {
        rootDir: tmp,
        staleMs: -1,
      },
    );

    expect(result).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("exposes a structured retryable lock error", () => {
    const lease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
    });
    const err = new BrowserSessionLeaseLockError(lease);

    expect(err.code).toBe("browser_lease_locked");
    expect(err.suggestion).toContain("same browser workspace");
    expect(err.lease).toEqual(lease);
  });
});
