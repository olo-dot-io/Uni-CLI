/**
 * @owner       src/browser/native-host-install.ts
 * @does        Locate, install, inspect, and remove the Uni-CLI Chrome Native Messaging host manifest for supported Chromium browsers.
 * @needs       node:child_process, node:crypto, node:fs, node:path, src/browser/chrome-native-protocol.ts, src/engine/user-home.ts
 * @feeds       browser native-host CLI and browser doctor/status
 * @breaks      ChromeNativeHostInstallError on unsupported platforms/browsers, invalid executables/manifests, registry failure, or non-atomic filesystem writes.
 * @invariants  The manifest names one absolute executable, permits only the stable Uni-CLI extension id, and is never reported ready unless executable and registration both validate.
 * @side-effects Creates/removes per-user manifest files and, on Windows, per-user Chromium NativeMessagingHosts registry values.
 * @perf        O(number of selected browsers) filesystem/registry probes.
 * @concurrency Manifest replacement is atomic on filesystems; competing installers converge on identical bytes.
 * @test        tests/unit/native-host-install.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from "./chrome-native-protocol.js";
import { userHome } from "../engine/user-home.js";

export type ChromeNativeHostBrowser = "chrome" | "chromium" | "brave" | "edge";

export interface ChromeNativeHostStatus {
  browser: ChromeNativeHostBrowser;
  registration: "manifest" | "registry";
  location: string;
  state: "ready" | "missing" | "invalid";
  manifest_path: string;
  executable_path: string;
  extension_id: string;
  issues: string[];
  next_step: string;
}

export interface ChromeNativeHostOptions {
  browsers?: ChromeNativeHostBrowser[];
  platform?: NodeJS.Platform;
  homeDir?: string;
  executablePath?: string;
  registry?: ChromeNativeHostRegistry;
}

export interface ChromeNativeHostRegistry {
  read(key: string): string | null;
  write(key: string, manifestPath: string): void;
  remove(key: string): void;
}

interface NativeHostLocation {
  browser: ChromeNativeHostBrowser;
  registration: "manifest" | "registry";
  location: string;
  manifestPath: string;
}

interface NativeHostManifest {
  name: typeof CHROME_NATIVE_HOST_NAME;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

const ALL_BROWSERS: ChromeNativeHostBrowser[] = [
  "chrome",
  "chromium",
  "brave",
  "edge",
];

export class ChromeNativeHostInstallError extends Error {
  readonly retryable = false;
  readonly suggestion =
    "Run `unicli browser native-host status --json`, correct the reported path or permission, then reinstall the native host.";

  constructor(
    readonly code:
      | "native_host_platform_unsupported"
      | "native_host_browser_unsupported"
      | "native_host_executable_invalid"
      | "native_host_install_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChromeNativeHostInstallError";
  }
}

export function installChromeNativeHost(
  options: ChromeNativeHostOptions = {},
): ChromeNativeHostStatus[] {
  const environment = resolveEnvironment(options);
  assertExecutable(environment.executablePath);
  const manifest = nativeHostManifest(environment.executablePath);
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const location of environment.locations) {
    if (location.registration === "manifest") {
      writeManifestAtomically(location.manifestPath, encoded);
    } else {
      writeManifestAtomically(location.manifestPath, encoded);
      environment.registry.write(location.location, location.manifestPath);
    }
  }
  return inspectResolvedEnvironment(environment);
}

export function inspectChromeNativeHost(
  options: ChromeNativeHostOptions = {},
): ChromeNativeHostStatus[] {
  return inspectResolvedEnvironment(resolveEnvironment(options));
}

export function uninstallChromeNativeHost(
  options: ChromeNativeHostOptions = {},
): ChromeNativeHostStatus[] {
  const environment = resolveEnvironment(options);
  for (const location of environment.locations) {
    if (location.registration === "registry") {
      environment.registry.remove(location.location);
    }
    rmSync(location.manifestPath, { force: true });
  }
  return inspectResolvedEnvironment(environment);
}

export function nativeHostExecutablePath(): string {
  return resolve(
    import.meta.dirname,
    "..",
    "..",
    "bin",
    "unicli-browser-native-host",
  );
}

export function chromeExtensionDirectory(): string {
  return resolve(import.meta.dirname, "..", "..", "extension");
}

function nativeHostManifest(executablePath: string): NativeHostManifest {
  return {
    name: CHROME_NATIVE_HOST_NAME,
    description: "Uni-CLI browser runtime broker native host",
    path: executablePath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
  };
}

function resolveEnvironment(options: ChromeNativeHostOptions): {
  executablePath: string;
  locations: NativeHostLocation[];
  registry: ChromeNativeHostRegistry;
} {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? userHome();
  const executablePath = resolve(
    options.executablePath ?? nativeHostExecutablePath(),
  );
  const browsers = validateBrowsers(options.browsers ?? ALL_BROWSERS);
  const windowsManifestRoot = join(homeDir, ".unicli", "native-messaging");
  const registry = options.registry ?? new WindowsChromeNativeHostRegistry();
  return {
    executablePath,
    locations: nativeHostLocations(
      platform,
      homeDir,
      browsers,
      windowsManifestRoot,
    ),
    registry,
  };
}

function nativeHostLocations(
  platform: NodeJS.Platform,
  homeDir: string,
  browsers: ChromeNativeHostBrowser[],
  windowsManifestRoot: string,
): NativeHostLocation[] {
  if (platform === "darwin") {
    const roots: Record<ChromeNativeHostBrowser, string> = {
      chrome: join(homeDir, "Library/Application Support/Google/Chrome"),
      chromium: join(homeDir, "Library/Application Support/Chromium"),
      brave: join(
        homeDir,
        "Library/Application Support/BraveSoftware/Brave-Browser",
      ),
      edge: join(homeDir, "Library/Application Support/Microsoft Edge"),
    };
    return browsers.map((browser) => {
      const manifestPath = join(
        roots[browser],
        "NativeMessagingHosts",
        `${CHROME_NATIVE_HOST_NAME}.json`,
      );
      return {
        browser,
        registration: "manifest",
        location: manifestPath,
        manifestPath,
      };
    });
  }
  if (platform === "linux") {
    const roots: Record<ChromeNativeHostBrowser, string> = {
      chrome: join(homeDir, ".config/google-chrome"),
      chromium: join(homeDir, ".config/chromium"),
      brave: join(homeDir, ".config/BraveSoftware/Brave-Browser"),
      edge: join(homeDir, ".config/microsoft-edge"),
    };
    return browsers.map((browser) => {
      const manifestPath = join(
        roots[browser],
        "NativeMessagingHosts",
        `${CHROME_NATIVE_HOST_NAME}.json`,
      );
      return {
        browser,
        registration: "manifest",
        location: manifestPath,
        manifestPath,
      };
    });
  }
  if (platform === "win32") {
    const roots: Record<ChromeNativeHostBrowser, string> = {
      chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
      chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
      brave:
        "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
      edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
    };
    return browsers.map((browser) => ({
      browser,
      registration: "registry",
      location: `${roots[browser]}\\${CHROME_NATIVE_HOST_NAME}`,
      manifestPath: join(
        windowsManifestRoot,
        `${CHROME_NATIVE_HOST_NAME}.${browser}.json`,
      ),
    }));
  }
  throw new ChromeNativeHostInstallError(
    "native_host_platform_unsupported",
    `Chrome Native Messaging installation is unsupported on ${platform}`,
  );
}

function inspectResolvedEnvironment(environment: {
  executablePath: string;
  locations: NativeHostLocation[];
  registry: ChromeNativeHostRegistry;
}): ChromeNativeHostStatus[] {
  return environment.locations.map((location) => {
    const issues = inspectLocation(location, environment);
    const state = !registrationExists(location, environment.registry)
      ? "missing"
      : issues.length === 0
        ? "ready"
        : "invalid";
    return {
      browser: location.browser,
      registration: location.registration,
      location: location.location,
      state,
      manifest_path: location.manifestPath,
      executable_path: environment.executablePath,
      extension_id: CHROME_EXTENSION_ID,
      issues,
      next_step:
        state === "ready"
          ? "Open or reload the Uni-CLI extension; it will connect without launching a browser window."
          : `Run \`unicli browser native-host install --browser ${location.browser}\` after building or installing Uni-CLI.`,
    };
  });
}

function inspectLocation(
  location: NativeHostLocation,
  environment: {
    executablePath: string;
    registry: ChromeNativeHostRegistry;
  },
): string[] {
  const issues: string[] = [];
  const registeredPath =
    location.registration === "manifest"
      ? location.manifestPath
      : environment.registry.read(location.location);
  if (!registeredPath) {
    issues.push("Native Messaging registration is missing");
    return issues;
  }
  if (resolve(registeredPath) !== resolve(location.manifestPath)) {
    issues.push(`Registry points to an unexpected manifest: ${registeredPath}`);
    return issues;
  }
  const manifest = readManifest(location.manifestPath, issues);
  if (manifest) {
    const expected = nativeHostManifest(environment.executablePath);
    if (manifest.name !== expected.name)
      issues.push("Manifest name is invalid");
    if (manifest.path !== expected.path)
      issues.push(`Manifest executable is ${manifest.path}`);
    if (manifest.type !== expected.type)
      issues.push("Manifest type is invalid");
    if (
      manifest.allowed_origins.length !== 1 ||
      manifest.allowed_origins[0] !== expected.allowed_origins[0]
    ) {
      issues.push("Manifest allowed_origins does not match the extension id");
    }
  }
  try {
    assertExecutable(environment.executablePath);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

function readManifest(
  path: string,
  issues: string[],
): NativeHostManifest | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isNativeHostManifest(value)) {
      issues.push("Native Messaging manifest schema is invalid");
      return null;
    }
    return value;
  } catch (error) {
    issues.push(
      `Native Messaging manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function isNativeHostManifest(value: unknown): value is NativeHostManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.description === "string" &&
    typeof record.path === "string" &&
    record.type === "stdio" &&
    Array.isArray(record.allowed_origins) &&
    record.allowed_origins.every((origin) => typeof origin === "string")
  );
}

function registrationExists(
  location: NativeHostLocation,
  registry: ChromeNativeHostRegistry,
): boolean {
  return location.registration === "manifest"
    ? existsSync(location.manifestPath)
    : registry.read(location.location) !== null;
}

function writeManifestAtomically(path: string, encoded: string): void {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      `Failed to install Chrome native host manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertExecutable(path: string): void {
  try {
    accessSync(path, constants.F_OK | constants.X_OK);
  } catch (error) {
    throw new ChromeNativeHostInstallError(
      "native_host_executable_invalid",
      `Chrome native host executable is missing or not executable: ${path}`,
      { cause: error },
    );
  }
}

function validateBrowsers(
  browsers: ChromeNativeHostBrowser[],
): ChromeNativeHostBrowser[] {
  const unique = [...new Set(browsers)];
  if (unique.length === 0) {
    throw new ChromeNativeHostInstallError(
      "native_host_browser_unsupported",
      "At least one Chromium browser must be selected",
    );
  }
  for (const browser of unique) {
    if (!ALL_BROWSERS.includes(browser)) {
      throw new ChromeNativeHostInstallError(
        "native_host_browser_unsupported",
        `Unsupported Chromium browser: ${String(browser)}`,
      );
    }
  }
  return unique;
}

class WindowsChromeNativeHostRegistry implements ChromeNativeHostRegistry {
  read(key: string): string | null {
    try {
      const output = execFileSync("reg.exe", ["QUERY", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output.match(/REG_SZ\s+(.+)\s*$/m)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }

  write(key: string, manifestPath: string): void {
    runRegistryCommand([
      "ADD",
      key,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f",
    ]);
  }

  remove(key: string): void {
    if (this.read(key) === null) return;
    runRegistryCommand(["DELETE", key, "/f"]);
  }
}

function runRegistryCommand(args: string[]): void {
  try {
    execFileSync("reg.exe", args, {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch (error) {
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      `Windows NativeMessagingHosts registry update failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
