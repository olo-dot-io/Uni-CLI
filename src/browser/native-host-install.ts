/**
 * @owner       src/browser/native-host-install.ts
 * @does        Locate, install, and inspect the Uni-CLI Chrome Native Messaging host runtime, and manage its manifests/registrations for supported Chromium browsers.
 * @needs       node:child_process, node:crypto, node:fs, node:path, src/browser/chrome-native-protocol.ts, src/engine/user-home.ts, src/transport/process-owner.ts
 * @feeds       browser native-host CLI and browser doctor/status
 * @breaks      ChromeNativeHostInstallError on unsupported platforms/browsers, invalid executable images/runtime configs/manifests, registry failure, or non-atomic filesystem writes.
 * @invariants  The manifest names one absolute executable and permits only the stable Uni-CLI extension id; Windows registers an architecture-compatible PE in a content-addressed immutable runtime generation whose strict Node entrypoint config matches this installation; readiness requires the complete platform runtime and registration to validate.
 * @side-effects Creates/removes per-user manifest files and, on Windows, atomically installs one content-addressed launcher/config generation and updates per-user Chromium NativeMessagingHosts registry values.
 * @perf        O(number of selected browsers + Windows launcher bytes) filesystem/registry probes with constant-size buffers.
 * @concurrency Windows generations publish with one directory rename; competing installers strictly validate the winner; identical installers never touch a running executable, and upgrades switch manifests only after a new generation is complete.
 * @test        tests/unit/native-host-install.test.ts, tests/integration/browser-native-host.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import {
  CHROME_EXTENSION_ID,
  CHROME_NATIVE_HOST_NAME,
} from "./chrome-native-protocol.js";
import { userHome } from "../engine/user-home.js";
import { resolveProcessOwnerBinary } from "../transport/process-owner.js";

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
  runtime?: ChromeNativeHostRuntime;
  registry?: ChromeNativeHostRegistry;
}

export type ChromeNativeHostRuntime =
  | {
      kind: "posix";
      executablePath: string;
    }
  | {
      kind: "windows";
      launcherSourcePath: string;
      nodePath: string;
      entrypointPath: string;
    };

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

interface NativeHostLocationInspection {
  registrationExists: boolean;
  includeRuntimeIssues: boolean;
  issues: string[];
}

interface NativeHostManifest {
  name: typeof CHROME_NATIVE_HOST_NAME;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

interface WindowsNativeHostConfig {
  version: 1;
  node_path: string;
  entrypoint_path: string;
}

interface ResolvedNativeHostEnvironment {
  executablePath: string;
  runtime: ChromeNativeHostRuntime;
  configPath?: string;
  launcherDigest?: string;
  runtimeError?: ChromeNativeHostInstallError;
  locations: NativeHostLocation[];
  registry: ChromeNativeHostRegistry;
}

interface WindowsNativeHostRuntimePaths {
  executablePath: string;
  configPath: string;
  launcherDigest?: string;
  runtimeError?: ChromeNativeHostInstallError;
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
  installRuntime(environment);
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

export function nativeHostEntryPointPath(): string {
  return resolve(
    import.meta.dirname,
    "..",
    "..",
    "dist",
    "browser",
    "native-host-main.js",
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

function resolveEnvironment(
  options: ChromeNativeHostOptions,
): ResolvedNativeHostEnvironment {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? userHome();
  const runtime = resolveRuntime(platform, options.runtime);
  const browsers = validateBrowsers(options.browsers ?? ALL_BROWSERS);
  const windowsManifestRoot = join(homeDir, ".unicli", "native-messaging");
  const registry = options.registry ?? new WindowsChromeNativeHostRegistry();
  const locations = nativeHostLocations(
    platform,
    homeDir,
    browsers,
    windowsManifestRoot,
  );
  if (runtime.kind === "windows") {
    return {
      ...resolveWindowsRuntimePaths(windowsManifestRoot, runtime),
      runtime,
      locations,
      registry,
    };
  }
  return {
    executablePath: runtime.executablePath,
    runtime,
    locations,
    registry,
  };
}

function resolveWindowsRuntimePaths(
  root: string,
  runtime: Extract<ChromeNativeHostRuntime, { kind: "windows" }>,
): WindowsNativeHostRuntimePaths {
  try {
    const launcherDigest = sha256File(runtime.launcherSourcePath);
    const generation = windowsRuntimeGeneration(runtime, launcherDigest);
    const generationRoot = join(root, "runtimes", generation);
    return {
      executablePath: join(generationRoot, "unicli-browser-native-host.exe"),
      configPath: join(generationRoot, "unicli-browser-native-host.json"),
      launcherDigest,
    };
  } catch (error) {
    const generationRoot = join(root, "runtimes", "unresolved");
    return {
      executablePath: join(generationRoot, "unicli-browser-native-host.exe"),
      configPath: join(generationRoot, "unicli-browser-native-host.json"),
      runtimeError:
        error instanceof ChromeNativeHostInstallError
          ? error
          : invalidExecutable(
              runtime.launcherSourcePath,
              "Windows native host launcher cannot be fingerprinted",
              error,
            ),
    };
  }
}

function windowsRuntimeGeneration(
  runtime: Extract<ChromeNativeHostRuntime, { kind: "windows" }>,
  launcherDigest: string,
): string {
  return createHash("sha256")
    .update("unicli-browser-native-host\0")
    .update(launcherDigest)
    .update("\0")
    .update(expectedWindowsConfigText(runtime))
    .digest("hex");
}

function resolveRuntime(
  platform: NodeJS.Platform,
  configured: ChromeNativeHostRuntime | undefined,
): ChromeNativeHostRuntime {
  const runtime = configured ?? defaultRuntime(platform);
  if (platform === "win32" && runtime.kind !== "windows") {
    throw invalidExecutable(
      runtime.executablePath,
      "Windows Native Messaging requires a native PE launcher runtime",
    );
  }
  if (platform !== "win32" && runtime.kind !== "posix") {
    throw invalidExecutable(
      runtime.launcherSourcePath,
      `${platform} Native Messaging requires the POSIX host runtime`,
    );
  }
  return runtime.kind === "windows"
    ? {
        kind: "windows",
        launcherSourcePath: resolve(runtime.launcherSourcePath),
        nodePath: resolve(runtime.nodePath),
        entrypointPath: resolve(runtime.entrypointPath),
      }
    : {
        kind: "posix",
        executablePath: resolve(runtime.executablePath),
      };
}

function defaultRuntime(platform: NodeJS.Platform): ChromeNativeHostRuntime {
  if (platform !== "win32") {
    return { kind: "posix", executablePath: nativeHostExecutablePath() };
  }
  return {
    kind: "windows",
    launcherSourcePath: resolveCommandPath(resolveProcessOwnerBinary()),
    nodePath: process.execPath,
    entrypointPath: nativeHostEntryPointPath(),
  };
}

function resolveCommandPath(command: string): string {
  if (isAbsolute(command)) return resolve(command);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return resolve(command);
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

function inspectResolvedEnvironment(
  environment: ResolvedNativeHostEnvironment,
): ChromeNativeHostStatus[] {
  const locationInspections = environment.locations.map((location) =>
    inspectLocation(location, environment),
  );
  const runtimeIssues: string[] = [];
  if (
    locationInspections.some((inspection) => inspection.includeRuntimeIssues)
  ) {
    inspectRuntime(environment, runtimeIssues);
  }
  return environment.locations.map((location, index) => {
    const inspection = locationInspections[index];
    const issues = inspection.includeRuntimeIssues
      ? [...inspection.issues, ...runtimeIssues]
      : inspection.issues;
    const state = !inspection.registrationExists
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
  environment: ResolvedNativeHostEnvironment,
): NativeHostLocationInspection {
  const issues: string[] = [];
  const registeredPath =
    location.registration === "manifest"
      ? existsSync(location.manifestPath)
        ? location.manifestPath
        : null
      : environment.registry.read(location.location);
  const registrationExists = registeredPath !== null;
  if (!registeredPath) {
    issues.push("Native Messaging registration is missing");
    return {
      registrationExists,
      includeRuntimeIssues: false,
      issues,
    };
  }
  if (resolve(registeredPath) !== resolve(location.manifestPath)) {
    issues.push(`Registry points to an unexpected manifest: ${registeredPath}`);
    return {
      registrationExists,
      includeRuntimeIssues: false,
      issues,
    };
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
  return {
    registrationExists,
    includeRuntimeIssues: true,
    issues,
  };
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

function installRuntime(environment: ResolvedNativeHostEnvironment): void {
  if (environment.runtime.kind === "posix") {
    assertExecutable(environment.runtime.executablePath);
    return;
  }
  if (environment.runtimeError) throw environment.runtimeError;
  const configPath = environment.configPath;
  const launcherDigest = environment.launcherDigest;
  if (!configPath || !launcherDigest) {
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      "Windows native host runtime paths were not resolved",
    );
  }
  assertPortableExecutableArchitecture(
    environment.runtime.launcherSourcePath,
    "Windows native host launcher",
  );
  assertPortableExecutableArchitecture(
    environment.runtime.nodePath,
    "Node.js runtime",
  );
  assertRegularFile(
    environment.runtime.entrypointPath,
    "Chrome native host entrypoint",
  );
  assertFileDigest(
    environment.runtime.launcherSourcePath,
    launcherDigest,
    "Windows native host launcher changed while its generation was resolved",
  );
  const expectedConfigText = expectedWindowsConfigText(environment.runtime);
  installWindowsRuntimeGeneration(environment, expectedConfigText);
  assertFileDigest(
    environment.runtime.launcherSourcePath,
    launcherDigest,
    "Windows native host launcher changed during installation",
  );
  assertPublishedWindowsRuntimeGeneration(environment, expectedConfigText);
}

function installWindowsRuntimeGeneration(
  environment: ResolvedNativeHostEnvironment,
  expectedConfigText: string,
): void {
  const generationRoot = dirname(environment.executablePath);
  if (existsSync(generationRoot)) {
    assertPublishedWindowsRuntimeGeneration(environment, expectedConfigText);
    return;
  }
  const runtimeRoot = dirname(generationRoot);
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = join(
    runtimeRoot,
    `.generation.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  const temporaryExecutable = join(
    temporaryRoot,
    "unicli-browser-native-host.exe",
  );
  const temporaryConfig = join(
    temporaryRoot,
    "unicli-browser-native-host.json",
  );
  const launcherDigest = environment.launcherDigest;
  if (!launcherDigest || environment.runtime.kind !== "windows") {
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      "Windows native host runtime generation was not resolved",
    );
  }
  try {
    mkdirSync(temporaryRoot, { mode: 0o700 });
    copyFileSync(environment.runtime.launcherSourcePath, temporaryExecutable);
    chmodSync(temporaryExecutable, 0o700);
    assertPortableExecutableArchitecture(
      temporaryExecutable,
      "Prepared Windows native host launcher",
    );
    assertFileDigest(
      temporaryExecutable,
      launcherDigest,
      "Windows native host launcher changed while its generation was prepared",
    );
    writeFileSync(temporaryConfig, expectedConfigText, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporaryConfig, 0o600);
    assertFileDigest(
      environment.runtime.launcherSourcePath,
      launcherDigest,
      "Windows native host launcher changed before its generation was published",
    );
    renameSync(temporaryRoot, generationRoot);
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (existsSync(generationRoot)) {
      try {
        assertPublishedWindowsRuntimeGeneration(
          environment,
          expectedConfigText,
        );
        return;
      } catch (publishedError) {
        throw new ChromeNativeHostInstallError(
          "native_host_install_failed",
          `Concurrent Windows native host generation ${generationRoot} is invalid`,
          { cause: new AggregateError([error, publishedError]) },
        );
      }
    }
    if (error instanceof ChromeNativeHostInstallError) throw error;
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      `Failed to publish Windows native host generation ${generationRoot}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertPublishedWindowsRuntimeGeneration(
  environment: ResolvedNativeHostEnvironment,
  expectedConfigText: string,
): void {
  const generationRoot = dirname(environment.executablePath);
  try {
    if (!statSync(generationRoot).isDirectory()) {
      throw new Error("generation path is not a directory");
    }
  } catch (error) {
    throw invalidExecutable(
      generationRoot,
      "Windows native host generation is missing or invalid",
      error,
    );
  }
  const launcherDigest = environment.launcherDigest;
  const configPath = environment.configPath;
  if (!launcherDigest || !configPath) {
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      "Windows native host generation metadata is missing",
    );
  }
  assertPortableExecutableArchitecture(
    environment.executablePath,
    "Installed Windows native host launcher",
  );
  assertFileDigest(
    environment.executablePath,
    launcherDigest,
    "Installed Windows native host generation contains unexpected bytes",
  );
  let installedConfig: string;
  try {
    installedConfig = readFileSync(configPath, "utf8");
  } catch (error) {
    throw invalidExecutable(
      configPath,
      "Installed Windows native host launch config is unreadable",
      error,
    );
  }
  if (installedConfig !== expectedConfigText) {
    throw invalidExecutable(
      configPath,
      "Installed Windows native host launch config contains unexpected bytes",
    );
  }
}

function inspectRuntime(
  environment: ResolvedNativeHostEnvironment,
  issues: string[],
): void {
  const runtime = environment.runtime;
  if (runtime.kind === "posix") {
    recordInspectionIssue(
      () => assertExecutable(runtime.executablePath),
      issues,
    );
    return;
  }
  if (environment.runtimeError) {
    issues.push(environment.runtimeError.message);
    return;
  }
  const launcherDigest = environment.launcherDigest;
  if (!launcherDigest) {
    issues.push("Windows native host launcher digest is missing");
    return;
  }
  recordInspectionIssue(() => {
    assertPortableExecutableArchitecture(
      runtime.launcherSourcePath,
      "Windows native host launcher source",
    );
    assertFileDigest(
      runtime.launcherSourcePath,
      launcherDigest,
      "Windows native host launcher source changed while its generation was resolved",
    );
  }, issues);
  recordInspectionIssue(() => {
    assertPortableExecutableArchitecture(
      environment.executablePath,
      "Installed Windows native host launcher",
    );
    assertFileDigest(
      environment.executablePath,
      launcherDigest,
      "Installed Windows native host generation contains unexpected bytes",
    );
  }, issues);
  recordInspectionIssue(
    () =>
      assertPortableExecutableArchitecture(runtime.nodePath, "Node.js runtime"),
    issues,
  );
  recordInspectionIssue(
    () =>
      assertRegularFile(
        runtime.entrypointPath,
        "Chrome native host entrypoint",
      ),
    issues,
  );
  inspectWindowsConfig(environment, issues);
}

function recordInspectionIssue(inspect: () => void, issues: string[]): void {
  try {
    inspect();
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
}

function expectedWindowsConfig(
  runtime: Extract<ChromeNativeHostRuntime, { kind: "windows" }>,
): WindowsNativeHostConfig {
  return {
    version: 1,
    node_path: runtime.nodePath,
    entrypoint_path: runtime.entrypointPath,
  };
}

function expectedWindowsConfigText(
  runtime: Extract<ChromeNativeHostRuntime, { kind: "windows" }>,
): string {
  return `${JSON.stringify(expectedWindowsConfig(runtime), null, 2)}\n`;
}

function inspectWindowsConfig(
  environment: ResolvedNativeHostEnvironment,
  issues: string[],
): void {
  const configPath = environment.configPath;
  if (!configPath || environment.runtime.kind !== "windows") {
    issues.push("Windows native host launch config path is missing");
    return;
  }
  try {
    const encoded = readFileSync(configPath, "utf8");
    const decoded = JSON.parse(encoded) as unknown;
    if (!isWindowsNativeHostConfig(decoded)) {
      issues.push("Windows native host launch config schema is invalid");
      return;
    }
    const expected = expectedWindowsConfig(environment.runtime);
    if (
      decoded.version !== expected.version ||
      decoded.node_path !== expected.node_path ||
      decoded.entrypoint_path !== expected.entrypoint_path ||
      encoded !== expectedWindowsConfigText(environment.runtime)
    ) {
      issues.push(
        "Windows native host launch config does not match this install",
      );
    }
  } catch (error) {
    issues.push(
      `Windows native host launch config is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isWindowsNativeHostConfig(
  candidate: unknown,
): candidate is WindowsNativeHostConfig {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.version === 1 &&
    typeof record.node_path === "string" &&
    typeof record.entrypoint_path === "string"
  );
}

function writeManifestAtomically(path: string, encoded: string): void {
  writeFileAtomically(path, encoded, 0o600, "Chrome native host manifest");
}

function writeFileAtomically(
  path: string,
  contents: string,
  mode: number,
  label: string,
): void {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ChromeNativeHostInstallError(
      "native_host_install_failed",
      `Failed to install ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertExecutable(path: string): void {
  try {
    accessSync(path, constants.F_OK | constants.X_OK);
    if (!statSync(path).isFile()) throw new Error("path is not a regular file");
  } catch (error) {
    throw new ChromeNativeHostInstallError(
      "native_host_executable_invalid",
      `Chrome native host executable is missing or not executable: ${path}`,
      { cause: error },
    );
  }
}

function assertRegularFile(path: string, role: string): void {
  try {
    if (!statSync(path).isFile()) throw new Error("path is not a regular file");
  } catch (error) {
    throw invalidExecutable(path, `${role} is missing or invalid`, error);
  }
}

function assertPortableExecutableArchitecture(
  path: string,
  role: string,
): void {
  const expectedMachine = windowsRuntimeMachine();
  const actualMachine = portableExecutableMachine(path, role);
  if (actualMachine !== expectedMachine) {
    throw invalidExecutable(
      path,
      `${role} architecture ${actualMachine} does not match the running Node architecture ${expectedMachine}`,
    );
  }
}

function windowsRuntimeMachine(): "x64" | "arm64" {
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  throw invalidExecutable(
    process.execPath,
    `Windows Native Messaging is unsupported on Node architecture ${process.arch}`,
  );
}

function portableExecutableMachine(
  path: string,
  role: string,
): "x64" | "arm64" {
  try {
    const fileSize = statSync(path).size;
    if (fileSize < 0x9a) throw new Error("image is too small");
    const descriptor = openSync(path, "r");
    try {
      const dosHeader = Buffer.alloc(64);
      if (readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== 64) {
        throw new Error("DOS header is truncated");
      }
      if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
        throw new Error("DOS signature is missing");
      }
      const peOffset = dosHeader.readUInt32LE(0x3c);
      if (peOffset < 64 || peOffset + 26 > fileSize) {
        throw new Error("PE header offset is invalid");
      }
      const peHeader = Buffer.alloc(26);
      if (
        readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !==
        peHeader.length
      ) {
        throw new Error("PE header is truncated");
      }
      if (peHeader.toString("binary", 0, 4) !== "PE\0\0") {
        throw new Error("PE signature is missing");
      }
      const machine = peHeader.readUInt16LE(4);
      if (machine !== 0x8664 && machine !== 0xaa64) {
        throw new Error("PE machine is not x64 or arm64");
      }
      if ((peHeader.readUInt16LE(22) & 0x0002) === 0) {
        throw new Error("PE image is not executable");
      }
      const optionalHeaderSize = peHeader.readUInt16LE(20);
      if (
        optionalHeaderSize < 2 ||
        peOffset + 24 + optionalHeaderSize > fileSize
      ) {
        throw new Error("PE optional header is invalid");
      }
      const optionalMagic = Buffer.alloc(2);
      readSync(descriptor, optionalMagic, 0, 2, peOffset + 24);
      if (optionalMagic.readUInt16LE(0) !== 0x20b) {
        throw new Error("PE image is not 64-bit");
      }
      return machine === 0x8664 ? "x64" : "arm64";
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    throw invalidExecutable(
      path,
      `${role} is not a supported 64-bit Portable Executable`,
      error,
    );
  }
}

function sha256File(path: string): string {
  const digest = createHash("sha256");
  const descriptor = openSync(path, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function assertFileDigest(
  path: string,
  expectedDigest: string,
  message: string,
): void {
  try {
    if (sha256File(path) !== expectedDigest) {
      throw new Error("SHA-256 digest does not match the runtime generation");
    }
  } catch (error) {
    throw invalidExecutable(path, message, error);
  }
}

function invalidExecutable(
  path: string,
  message: string,
  cause?: unknown,
): ChromeNativeHostInstallError {
  return new ChromeNativeHostInstallError(
    "native_host_executable_invalid",
    `${message}: ${path}`,
    cause === undefined ? undefined : { cause },
  );
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
