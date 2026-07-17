import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installChromeNativeHost,
  inspectChromeNativeHost,
  uninstallChromeNativeHost,
  type ChromeNativeHostRegistry,
  type ChromeNativeHostRuntime,
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
    const fixture = createPosixFixture();
    const installed = installChromeNativeHost({
      platform: "darwin",
      homeDir: fixture.home,
      runtime: fixture.runtime,
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
      path: fixture.runtime.executablePath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
    });
  });

  it("reports a tampered manifest as invalid rather than ready", () => {
    const fixture = createPosixFixture();
    const [installed] = installChromeNativeHost({
      platform: "linux",
      homeDir: fixture.home,
      runtime: fixture.runtime,
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
        runtime: fixture.runtime,
        browsers: ["chromium"],
      }),
    ).toEqual([
      expect.objectContaining({
        state: "invalid",
        issues: ["Manifest allowed_origins does not match the extension id"],
      }),
    ]);
  });

  it("installs one validated Windows PE launcher and exact per-browser registrations", () => {
    const fixture = createWindowsFixture();
    const registry = new MemoryRegistry();
    const installed = installChromeNativeHost({
      platform: "win32",
      homeDir: fixture.home,
      runtime: fixture.runtime,
      browsers: ["chrome", "edge"],
      registry,
    });

    expect(installed.map((entry) => entry.state)).toEqual(["ready", "ready"]);
    expect(new Set(installed.map((entry) => entry.executable_path)).size).toBe(
      1,
    );
    const installedExecutable = installed[0].executable_path;
    const generationRoot = dirname(installedExecutable);
    expect(dirname(generationRoot)).toBe(
      join(fixture.home, ".unicli", "native-messaging", "runtimes"),
    );
    expect(basename(generationRoot)).toMatch(/^[0-9a-f]{64}$/);
    expect(basename(installedExecutable)).toBe(
      "unicli-browser-native-host.exe",
    );
    expect(readFileSync(installedExecutable)).toEqual(
      readFileSync(fixture.runtime.launcherSourcePath),
    );
    expect(
      JSON.parse(
        readFileSync(
          join(generationRoot, "unicli-browser-native-host.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      version: 1,
      node_path: fixture.runtime.nodePath,
      entrypoint_path: fixture.runtime.entrypointPath,
    });
    expect(new Set(installed.map((entry) => entry.manifest_path)).size).toBe(2);
    expect(registry.values.size).toBe(2);
    expect(registry.readCount).toBe(2);
    expect([...registry.values.values()]).toEqual([
      installed[0].manifest_path,
      installed[1].manifest_path,
    ]);
    const manifest = JSON.parse(
      readFileSync(installed[0].manifest_path, "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.path).toBe(installed[0].executable_path);
  });

  it("reports a tampered Windows launcher and launch config as invalid", () => {
    const fixture = createWindowsFixture();
    const registry = new MemoryRegistry();
    const [installed] = installChromeNativeHost({
      platform: "win32",
      homeDir: fixture.home,
      runtime: fixture.runtime,
      browsers: ["chrome"],
      registry,
    });
    const corruptedLauncher = Buffer.from("#!/bin/sh\nexit 0\n");
    writeFileSync(installed.executable_path, corruptedLauncher);
    const configPath = join(
      dirname(installed.executable_path),
      "unicli-browser-native-host.json",
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        node_path: join(fixture.home, "wrong-node.exe"),
        entrypoint_path: fixture.runtime.entrypointPath,
      }),
    );

    expect(
      inspectChromeNativeHost({
        platform: "win32",
        homeDir: fixture.home,
        runtime: fixture.runtime,
        browsers: ["chrome"],
        registry,
      }),
    ).toEqual([
      expect.objectContaining({
        state: "invalid",
        issues: expect.arrayContaining([
          expect.stringContaining("Portable Executable"),
          expect.stringContaining("launch config does not match"),
        ]),
      }),
    ]);
    expect(() =>
      installChromeNativeHost({
        platform: "win32",
        homeDir: fixture.home,
        runtime: fixture.runtime,
        browsers: ["chrome"],
        registry,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "native_host_executable_invalid",
      }),
    );
    expect(readFileSync(installed.executable_path)).toEqual(corruptedLauncher);
  });

  it("reuses an exact Windows generation and publishes launcher updates beside it", () => {
    const fixture = createWindowsFixture();
    const registry = new MemoryRegistry();
    const [first] = installChromeNativeHost({
      platform: "win32",
      homeDir: fixture.home,
      runtime: fixture.runtime,
      browsers: ["chrome"],
      registry,
    });
    const firstIdentity = statSync(first.executable_path).ino;
    const firstBytes = readFileSync(first.executable_path);

    const [second] = installChromeNativeHost({
      platform: "win32",
      homeDir: fixture.home,
      runtime: fixture.runtime,
      browsers: ["chrome"],
      registry,
    });

    expect(second.executable_path).toBe(first.executable_path);
    expect(statSync(second.executable_path).ino).toBe(firstIdentity);
    expect(second.state).toBe("ready");

    appendFileSync(fixture.runtime.launcherSourcePath, Buffer.from([0]));
    const [updated] = installChromeNativeHost({
      platform: "win32",
      homeDir: fixture.home,
      runtime: fixture.runtime,
      browsers: ["chrome"],
      registry,
    });

    expect(updated.state).toBe("ready");
    expect(updated.executable_path).not.toBe(first.executable_path);
    expect(readFileSync(first.executable_path)).toEqual(firstBytes);
    expect(readFileSync(updated.executable_path)).toEqual(
      readFileSync(fixture.runtime.launcherSourcePath),
    );
  });

  it("removes only selected registrations and reports them missing", () => {
    const fixture = createPosixFixture();
    installChromeNativeHost({
      platform: "darwin",
      homeDir: fixture.home,
      runtime: fixture.runtime,
      browsers: ["brave"],
    });

    expect(
      uninstallChromeNativeHost({
        platform: "darwin",
        homeDir: fixture.home,
        runtime: fixture.runtime,
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
    const fixture = createPosixFixture();
    expect(() =>
      installChromeNativeHost({
        platform: "darwin",
        homeDir: fixture.home,
        runtime: {
          kind: "posix",
          executablePath: join(fixture.home, "missing-host"),
        },
        browsers: ["chrome"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "native_host_executable_invalid" }),
    );
  });

  it("refuses to register a POSIX script as a Windows native host", () => {
    const fixture = createWindowsFixture();
    const script = join(fixture.home, "bin", "host-script");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o700);

    expect(() =>
      installChromeNativeHost({
        platform: "win32",
        homeDir: fixture.home,
        runtime: {
          ...fixture.runtime,
          launcherSourcePath: script,
        },
        browsers: ["chrome"],
        registry: new MemoryRegistry(),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "native_host_executable_invalid" }),
    );
  });

  it("refuses a Windows launcher built for a different architecture", () => {
    const fixture = createWindowsFixture();
    writePortableExecutable(
      fixture.runtime.launcherSourcePath,
      process.arch === "arm64" ? 0x8664 : 0xaa64,
    );

    expect(() =>
      installChromeNativeHost({
        platform: "win32",
        homeDir: fixture.home,
        runtime: fixture.runtime,
        browsers: ["chrome"],
        registry: new MemoryRegistry(),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "native_host_executable_invalid",
        message: expect.stringContaining("does not match"),
      }),
    );
  });
});

function createPosixFixture(): {
  home: string;
  runtime: Extract<ChromeNativeHostRuntime, { kind: "posix" }>;
} {
  const home = mkdtempSync(join(tmpdir(), "unicli-native-host-"));
  temporaryRoots.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, "unicli-browser-native-host");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o700);
  return { home, runtime: { kind: "posix", executablePath: executable } };
}

function createWindowsFixture(): {
  home: string;
  runtime: Extract<ChromeNativeHostRuntime, { kind: "windows" }>;
} {
  const home = mkdtempSync(join(tmpdir(), "unicli-native-host-win-"));
  temporaryRoots.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const launcherSourcePath = join(bin, "unicli-process-owner.exe");
  const nodePath = join(bin, "node.exe");
  const entrypointPath = join(bin, "native-host-main.js");
  writePortableExecutable(launcherSourcePath);
  writePortableExecutable(nodePath);
  writeFileSync(entrypointPath, "process.exit(0);\n");
  return {
    home,
    runtime: {
      kind: "windows",
      launcherSourcePath,
      nodePath,
      entrypointPath,
    },
  };
}

function writePortableExecutable(
  path: string,
  machine = process.arch === "arm64" ? 0xaa64 : 0x8664,
): void {
  const image = Buffer.alloc(512);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "binary");
  image.writeUInt16LE(machine, 0x84);
  image.writeUInt16LE(1, 0x86);
  image.writeUInt16LE(0xf0, 0x94);
  image.writeUInt16LE(0x22, 0x96);
  image.writeUInt16LE(0x20b, 0x98);
  writeFileSync(path, image);
}

// REASON: the Windows registry is an external OS boundary; this in-memory implementation proves exact key/value behavior without mutating the developer machine.
class MemoryRegistry implements ChromeNativeHostRegistry {
  readonly values = new Map<string, string>();
  readCount = 0;

  read(key: string): string | null {
    this.readCount += 1;
    return this.values.get(key) ?? null;
  }

  write(key: string, manifestPath: string): void {
    this.values.set(key, manifestPath);
  }

  remove(key: string): void {
    this.values.delete(key);
  }
}
