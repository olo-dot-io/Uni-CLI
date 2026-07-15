import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installChromeNativeHost,
  inspectChromeNativeHost,
  uninstallChromeNativeHost,
  type ChromeNativeHostRegistry,
} from "../../src/browser/native-host-install.js";
import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from "../../src/browser/chrome-native-protocol.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Chrome native host installation", () => {
  it("atomically installs and validates the exact macOS Chrome manifest", () => {
    const fixture = createFixture();
    const installed = installChromeNativeHost({
      platform: "darwin",
      homeDir: fixture.home,
      executablePath: fixture.executable,
      browsers: ["chrome"],
    });

    expect(installed).toEqual([
      expect.objectContaining({
        browser: "chrome",
        registration: "manifest",
        state: "ready",
        issues: [],
      }),
    ]);
    const manifest = JSON.parse(
      readFileSync(installed[0].manifest_path, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toEqual({
      name: CHROME_NATIVE_HOST_NAME,
      description: "Uni-CLI browser runtime broker native host",
      path: fixture.executable,
      type: "stdio",
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
    });
  });

  it("reports a tampered manifest as invalid rather than ready", () => {
    const fixture = createFixture();
    const [installed] = installChromeNativeHost({
      platform: "linux",
      homeDir: fixture.home,
      executablePath: fixture.executable,
      browsers: ["chromium"],
    });
    const manifest = JSON.parse(
      readFileSync(installed.manifest_path, "utf8"),
    ) as Record<string, unknown>;
    manifest.allowed_origins = ["chrome-extension://attacker/"];
    writeFileSync(installed.manifest_path, JSON.stringify(manifest));

    expect(
      inspectChromeNativeHost({
        platform: "linux",
        homeDir: fixture.home,
        executablePath: fixture.executable,
        browsers: ["chromium"],
      }),
    ).toEqual([
      expect.objectContaining({
        state: "invalid",
        issues: ["Manifest allowed_origins does not match the extension id"],
      }),
    ]);
  });

  it("installs isolated Windows manifests and exact per-browser registry values", () => {
    const fixture = createFixture();
    const registry = new MemoryRegistry();
    const installed = installChromeNativeHost({
      platform: "win32",
      homeDir: fixture.home,
      executablePath: fixture.executable,
      browsers: ["chrome", "edge"],
      registry,
    });

    expect(installed.map((entry) => entry.state)).toEqual(["ready", "ready"]);
    expect(new Set(installed.map((entry) => entry.manifest_path)).size).toBe(2);
    expect(registry.values.size).toBe(2);
    expect([...registry.values.values()]).toEqual([
      installed[0].manifest_path,
      installed[1].manifest_path,
    ]);
  });

  it("removes only selected registrations and reports them missing", () => {
    const fixture = createFixture();
    installChromeNativeHost({
      platform: "darwin",
      homeDir: fixture.home,
      executablePath: fixture.executable,
      browsers: ["brave"],
    });

    expect(
      uninstallChromeNativeHost({
        platform: "darwin",
        homeDir: fixture.home,
        executablePath: fixture.executable,
        browsers: ["brave"],
      }),
    ).toEqual([
      expect.objectContaining({
        state: "missing",
        issues: [expect.any(String)],
      }),
    ]);
  });

  it("refuses installation when the host executable is absent", () => {
    const fixture = createFixture();
    expect(() =>
      installChromeNativeHost({
        platform: "darwin",
        homeDir: fixture.home,
        executablePath: join(fixture.home, "missing-host"),
        browsers: ["chrome"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "native_host_executable_invalid" }),
    );
  });
});

function createFixture(): { home: string; executable: string } {
  const home = mkdtempSync(join(tmpdir(), "unicli-native-host-"));
  temporaryRoots.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "unicli-browser-native-host");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o700);
  return { home, executable };
}

class MemoryRegistry implements ChromeNativeHostRegistry {
  readonly values = new Map<string, string>();

  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  write(key: string, manifestPath: string): void {
    this.values.set(key, manifestPath);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}
