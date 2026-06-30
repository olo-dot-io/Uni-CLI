import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: childProcessMocks.execFileSync,
}));

describe("chromium cookie platform key lookup", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("falls back to macOS Safe Storage service lookup without an account", async () => {
    const mod = await import("../../src/engine/chromium-cookies-platform.js");
    mod._resetSecretCache();
    childProcessMocks.execFileSync.mockImplementation(
      (_command: string, args: string[]) => {
        if (args.includes("-a")) {
          throw new Error("account-specific lookup failed");
        }
        return "safe-storage-secret\n";
      },
    );

    const secret = mod.getEncryptionSecret(
      "chrome",
      "darwin",
      mod.KEYSTORE_SPECS.chrome,
      "/tmp/chrome-root",
    );

    expect(secret).toBe("safe-storage-secret");
    expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
      "/usr/bin/security",
      expect.not.arrayContaining(["-a"]),
      expect.any(Object),
    );
  });

  it("reports every macOS Safe Storage candidate when lookup fails", async () => {
    const mod = await import("../../src/engine/chromium-cookies-platform.js");
    mod._resetSecretCache();
    childProcessMocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(() =>
      mod.getEncryptionSecret(
        "chrome",
        "darwin",
        mod.KEYSTORE_SPECS.chrome,
        "/tmp/chrome-root",
      ),
    ).toThrow(/Chrome Safe Storage \/ <any account>/);
  });
});
