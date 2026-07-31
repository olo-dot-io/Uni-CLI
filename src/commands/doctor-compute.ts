import type { Command } from "commander";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLinuxOverlayPythonScript } from "../compute/linux-overlay.js";
import { buildMacosOverlayDaemonSwiftScript } from "../compute/macos-overlay.js";
import { buildWindowsOverlayPowerShellScript } from "../compute/windows-overlay.js";
import { getCDPPort, isCDPAvailable } from "../browser/launcher.js";
import { VERSION } from "../constants.js";
import {
  packageNameForSidecar,
  resolveSidecarBinary,
  type SidecarName,
} from "../transport/sidecar-binary.js";
import { StdioSidecarClient } from "../transport/sidecar.js";
import {
  probeCuaDriverFeatures,
  type CuaDriverFeatureProbe,
} from "../transport/adapters/cua-driver-contract.js";

const execFileP = promisify(execFile);

type CheckStatus = "ok" | "warn" | "fail" | "skip";

interface Remedy {
  message: string;
  command?: string;
  deeplink?: string;
  doc?: string;
}

interface ComputeDoctorCheck {
  name: string;
  transport: string;
  status: CheckStatus;
  ok: boolean;
  detail: string;
  remedy?: Remedy;
}

interface ComputeDoctorReport {
  status: "ok" | "issues";
  host: {
    platform: NodeJS.Platform;
    arch: string;
    version: string;
  };
  checks: ComputeDoctorCheck[];
  issueCount: number;
  installActions?: ComputeDoctorInstallAction[];
}

interface ComputeDoctorInstallAction {
  transport: string;
  packageName: string;
  command: string;
  ok: boolean;
  detail: string;
}

interface ComputeDoctorOptions {
  json?: boolean;
  install?: boolean;
  providers?: boolean;
}

export function registerDoctorComputeCommand(doctor: Command): void {
  doctor
    .command("compute")
    .description("Per-transport health probe for the compute family")
    .option("--json", "Machine-readable output")
    .option("--install", "Install the matching native sidecar when missing")
    .option("--providers", "Include optional external provider discovery")
    .action(async (opts: ComputeDoctorOptions) => {
      const report = await runComputeDoctor({ providers: opts.providers });
      if (opts.install) {
        report.installActions = await installMissingSidecars(report);
      }
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printComputeDoctor(report, opts);
      }
      process.exitCode = report.issueCount > 0 ? 1 : 0;
    });
}

export async function runComputeDoctor(
  options: { providers?: boolean } = {},
): Promise<ComputeDoctorReport> {
  const checks = [
    await checkSwift(),
    await checkMacAccessibility(),
    await checkMacScreenRecording(),
    await checkWindowsUia(),
    await checkLinuxAtspi(),
    await checkSubprocessLauncher(),
    await checkCdp(),
    checkVisualBackend(),
    await checkMacosAppKitOverlay(),
    await checkWindowsWin32Overlay(),
    await checkLinuxGtkOverlay(),
  ];
  if (options.providers) {
    checks.push(...(await checkExternalProviders()));
  }
  const issueCount = checks.filter((check) => check.status === "fail").length;
  return {
    status: issueCount === 0 ? "ok" : "issues",
    host: {
      platform: platform() as NodeJS.Platform,
      arch: arch(),
      version: VERSION,
    },
    checks,
    issueCount,
  };
}

async function checkMacosAppKitOverlay(): Promise<ComputeDoctorCheck> {
  if (platform() !== "darwin") {
    return skip("overlay", "macos-appkit", "host is not macOS");
  }
  const root = await mkdtemp(join(tmpdir(), "unicli-overlay-doctor-"));
  const scriptPath = join(root, "main.swift");
  try {
    await writeFile(scriptPath, buildMacosOverlayDaemonSwiftScript(), "utf8");
    await execFileP("swiftc", ["-parse", scriptPath], { timeout: 5_000 });
    return pass(
      "overlay",
      "macos-appkit",
      "AppKit overlay daemon source parses successfully",
    );
  } catch (error) {
    return fail(
      "overlay",
      "macos-appkit",
      `AppKit overlay daemon probe failed: ${errorMessage(error)}`,
      {
        message:
          "Install Xcode command line tools and verify the macOS overlay helper source.",
        command: "xcode-select --install",
        doc: "docs/operate/troubleshooting.md#overlaymacos_appkit",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function checkWindowsWin32Overlay(): Promise<ComputeDoctorCheck> {
  if (platform() !== "win32") {
    return skip("overlay", "windows-win32", "host is not Windows");
  }
  const root = await mkdtemp(join(tmpdir(), "unicli-overlay-doctor-win-"));
  const scriptPath = join(root, "overlay.ps1");
  try {
    await writeFile(scriptPath, buildWindowsOverlayPowerShellScript(), "utf8");
    await execFileP(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${escapePowerShellSingleQuoted(scriptPath)}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }; Add-Type -AssemblyName System.Windows.Forms`,
      ],
      { timeout: 5_000 },
    );
    return pass(
      "overlay",
      "windows-win32",
      "Win32 overlay PowerShell daemon source parses successfully",
    );
  } catch (error) {
    return fail(
      "overlay",
      "windows-win32",
      `Win32 overlay daemon probe failed: ${errorMessage(error)}`,
      {
        message:
          "Run from a Windows desktop session with PowerShell and .NET Windows Forms available.",
        command: "unicli doctor compute --json",
        doc: "docs/operate/troubleshooting.md#overlaywindows_win32",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function checkLinuxGtkOverlay(): Promise<ComputeDoctorCheck> {
  if (platform() !== "linux") {
    return skip("overlay", "linux-gtk", "host is not Linux");
  }
  const root = await mkdtemp(join(tmpdir(), "unicli-overlay-doctor-linux-"));
  const scriptPath = join(root, "overlay.py");
  try {
    await writeFile(scriptPath, buildLinuxOverlayPythonScript(), "utf8");
    await execFileP("python3", ["-m", "py_compile", scriptPath], {
      timeout: 5_000,
    });
    await execFileP(
      "python3",
      [
        "-c",
        'import cairo, gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk',
      ],
      { timeout: 5_000 },
    );
    return pass(
      "overlay",
      "linux-gtk",
      "GTK overlay Python daemon source parses and imports GTK successfully",
    );
  } catch (error) {
    return fail(
      "overlay",
      "linux-gtk",
      `GTK overlay daemon probe failed: ${errorMessage(error)}`,
      {
        message:
          "Install python3, PyGObject GTK 3, and pycairo in a graphical Linux session.",
        command:
          'python3 -c \'import cairo, gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk\'',
        doc: "docs/operate/troubleshooting.md#overlaylinux_gtk",
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function checkExternalProviders(): Promise<ComputeDoctorCheck[]> {
  return [
    await checkCuaDriver(),
    await checkConfiguredProvider({
      name: "external-provider",
      commandEnv: "UNICLI_COMPUTE_PROVIDER_COMMAND",
      argsEnv: "UNICLI_COMPUTE_PROVIDER_ARGS",
    }),
    await checkPlatformProvider(),
    checkVisualModelProvider(),
  ];
}

async function checkCuaDriver(): Promise<ComputeDoctorCheck> {
  const command = process.env.UNICLI_CUA_DRIVER_COMMAND?.trim() || "cua-driver";
  const args = parseCuaDriverArgs(process.env.UNICLI_CUA_DRIVER_ARGS);
  if (!args.ok) {
    return warn("cua-driver", "contract-0.2.0", args.reason, {
      message:
        "Set UNICLI_CUA_DRIVER_ARGS to a JSON array of literal argv entries.",
      command: 'UNICLI_CUA_DRIVER_ARGS=\'["--socket","/path"]\'',
      doc: "docs/operate/compute.md#explicit-coordinate-and-os-driver-operations",
    });
  }
  try {
    const version = await execFileP(command, [...args.value, "--version"], {
      timeout: 5_000,
    });
    let features: CuaDriverFeatureProbe;
    try {
      const docs = await execFileP(
        command,
        [...args.value, "dump-docs", "--type", "mcp"],
        { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      );
      features = probeCuaDriverFeatures(JSON.parse(docs.stdout));
    } catch (error) {
      return warn(
        "cua-driver",
        "contract-0.2.0",
        `Cua Driver is installed but its live tool contract could not be inspected: ${errorMessage(error)}`,
        {
          message:
            "Install a Cua Driver release exposing machine-readable MCP tool schemas.",
          command: `${command} dump-docs --type mcp`,
          doc: "docs/operate/compute.md#explicit-coordinate-and-os-driver-operations",
        },
      );
    }
    if (!features.ok) {
      const missing = features.missingTools.join(", ");
      const incompatible = features.incompatibleInputs
        .map((field) => `${field.tool}.${field.field}:${field.reason}`)
        .join(", ");
      return warn(
        "cua-driver",
        "contract-0.2.0",
        `Cua Driver does not satisfy Uni-CLI's required live tool contract (${features.requiredToolCount - features.missingTools.length}/${features.requiredToolCount} tools present${missing ? `; missing ${missing}` : ""}${incompatible ? `; incompatible ${incompatible}` : ""})`,
        {
          message:
            "Upgrade Cua Driver until its feature probe contains every required tool and input field.",
          command: `${command} dump-docs --type mcp`,
          doc: "docs/operate/compute.md#explicit-coordinate-and-os-driver-operations",
        },
      );
    }
    try {
      const status = await execFileP(command, [...args.value, "status"], {
        timeout: 5_000,
      });
      return pass(
        "cua-driver",
        "contract-0.2.0",
        `${firstLine(version.stdout) || "Cua Driver installed"}; ${features.requiredToolCount}/${features.requiredToolCount} required live tools compatible; ${firstLine(status.stdout) || "daemon reachable"}`,
      );
    } catch (error) {
      return warn(
        "cua-driver",
        "contract-0.2.0",
        `Cua Driver is installed but its daemon is unavailable: ${errorMessage(error)}`,
        {
          message:
            "Start the Cua Driver daemon and verify its permission policy before selecting --via driver.",
          command: `${command} serve`,
          doc: "docs/operate/compute.md#explicit-coordinate-and-os-driver-operations",
        },
      );
    }
  } catch (error) {
    if (isMissingExecutable(error)) {
      return skip(
        "cua-driver",
        "contract-0.2.0",
        `optional executable ${JSON.stringify(command)} is not installed`,
      );
    }
    return warn(
      "cua-driver",
      "contract-0.2.0",
      `Cua Driver version probe failed: ${errorMessage(error)}`,
      {
        message:
          "Repair UNICLI_CUA_DRIVER_COMMAND or the installed Cua Driver binary.",
        command: `${command} --version`,
        doc: "docs/operate/compute.md#explicit-coordinate-and-os-driver-operations",
      },
    );
  }
}

function parseCuaDriverArgs(
  value: string | undefined,
): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (!value?.trim()) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? { ok: true, value: parsed }
      : {
          ok: false,
          reason: "UNICLI_CUA_DRIVER_ARGS must be a JSON array of strings",
        };
  } catch (error) {
    return {
      ok: false,
      reason: `UNICLI_CUA_DRIVER_ARGS is invalid JSON: ${errorMessage(error)}`,
    };
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}

function isMissingExecutable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; cause?: unknown };
  return (
    record.code === "ENOENT" ||
    (record.cause !== undefined && isMissingExecutable(record.cause))
  );
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

async function checkConfiguredProvider(opts: {
  name: string;
  commandEnv: string;
  argsEnv: string;
}): Promise<ComputeDoctorCheck> {
  const command = process.env[opts.commandEnv]?.trim();
  if (!command) {
    return skip(
      "provider",
      opts.name,
      `set ${opts.commandEnv} to enable this optional provider probe`,
    );
  }
  const args = parseProviderArgs(process.env[opts.argsEnv]);
  try {
    await execFileP(command, args, { timeout: 5_000 });
    return pass(
      "provider",
      opts.name,
      `${opts.commandEnv} target is available`,
    );
  } catch (error) {
    return warn(
      "provider",
      opts.name,
      `${opts.commandEnv} target is not available: ${errorMessage(error)}`,
      {
        message:
          "Fix the configured provider command or unset it to skip this optional probe.",
        command: `${opts.commandEnv}=<command> ${opts.argsEnv}='["--version"]' unicli doctor compute --providers`,
      },
    );
  }
}

async function checkPlatformProvider(): Promise<ComputeDoctorCheck> {
  const host = platform();
  const envByPlatform: Partial<Record<NodeJS.Platform, string>> = {
    darwin: "UNICLI_MACOS_COMPUTE_PROVIDER_COMMAND",
    win32: "UNICLI_WINDOWS_COMPUTE_PROVIDER_COMMAND",
    linux: "UNICLI_LINUX_COMPUTE_PROVIDER_COMMAND",
  };
  const commandEnv = envByPlatform[host];
  if (!commandEnv) {
    return skip("provider", "platform-provider", `host ${host} is unsupported`);
  }
  return checkConfiguredProvider({
    name: "platform-provider",
    commandEnv,
    argsEnv: commandEnv.replace(/_COMMAND$/, "_ARGS"),
  });
}

function parseProviderArgs(value: string | undefined): string[] {
  if (!value?.trim()) return ["--version"];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {
    // Fall through to whitespace splitting for simple probes.
  }
  return value.split(/\s+/).filter(Boolean);
}

function checkVisualModelProvider(): ComputeDoctorCheck {
  const provider =
    process.env.UNICLI_VISUAL_MODEL ??
    process.env.VISUAL_MODEL ??
    process.env.VISUAL_BACKEND;
  if (provider?.trim()) {
    return pass(
      "provider",
      "visual-model",
      `visual model provider configured: ${provider}`,
    );
  }
  return warn("provider", "visual-model", "no visual model provider selected", {
    message:
      "Set UNICLI_VISUAL_MODEL only when an explicitly selected visual route needs model perception.",
    doc: "docs/operate/troubleshooting.md#visualno_backend",
  });
}

async function checkMacScreenRecording(): Promise<ComputeDoctorCheck> {
  if (platform() !== "darwin") {
    return skip("desktop-ax", "screen-recording", "host is not macOS");
  }
  const path = join(
    tmpdir(),
    `unicli-screen-recording-probe-${process.pid}-${Date.now()}.png`,
  );
  try {
    await execFileP("screencapture", ["-x", "-t", "png", path], {
      timeout: 5_000,
    });
    const info = await stat(path);
    if (info.size > 0) {
      return {
        ...pass(
          "desktop-ax",
          "screen-recording",
          "Screen Recording probe captured a frame",
        ),
        remedy: screenRecordingRemedy(),
      };
    }
    return fail(
      "desktop-ax",
      "screen-recording",
      "Screen Recording probe produced an empty capture",
      screenRecordingRemedy(),
    );
  } catch (error) {
    return fail(
      "desktop-ax",
      "screen-recording",
      errorMessage(error),
      screenRecordingRemedy(),
    );
  } finally {
    await rm(path, { force: true });
  }
}

function screenRecordingRemedy(): Remedy {
  return {
    message: "Grant Screen Recording to the app or terminal launching Uni-CLI.",
    deeplink:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    doc: "docs/operate/troubleshooting.md#desktop-axscreen-recording",
  };
}

async function checkSwift(): Promise<ComputeDoctorCheck> {
  if (platform() !== "darwin")
    return skip("desktop-ax", "swift", "host is not macOS");
  try {
    await execFileP("swift", ["--version"], { timeout: 5_000 });
    return pass("desktop-ax", "swift", "Swift runtime available");
  } catch {
    return fail("desktop-ax", "swift", "Swift runtime not available", {
      message: "Install Xcode command line tools.",
      command: "xcode-select --install",
      doc: "docs/operate/troubleshooting.md#desktop-axbinary_missing",
    });
  }
}

async function checkMacAccessibility(): Promise<ComputeDoctorCheck> {
  if (platform() !== "darwin") {
    return skip("desktop-ax", "accessibility", "host is not macOS");
  }
  try {
    const { stdout } = await execFileP(
      "swift",
      [
        "-e",
        [
          "import ApplicationServices",
          'print(AXIsProcessTrusted() ? "true" : "false")',
        ].join("\n"),
      ],
      { timeout: 5_000, encoding: "utf8" },
    );
    if (stdout.trim() === "true") {
      return pass("desktop-ax", "accessibility", "Accessibility granted");
    }
    return fail("desktop-ax", "accessibility", "Accessibility not granted", {
      message: "Grant Accessibility to the app or terminal launching Uni-CLI.",
      deeplink:
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      doc: "docs/operate/troubleshooting.md#desktop-axpermission",
    });
  } catch (error) {
    return fail("desktop-ax", "accessibility", errorMessage(error), {
      message: "Install Swift and retry the Accessibility probe.",
      command: "xcode-select --install",
      doc: "docs/operate/troubleshooting.md#desktop-axpermission",
    });
  }
}

async function checkWindowsUia(): Promise<ComputeDoctorCheck> {
  if (platform() !== "win32")
    return skip("desktop-uia", "sidecar", "host is not Windows");
  return probeSidecar({
    transport: "desktop-uia",
    name: "sidecar",
    sidecarName: "unicli-uia",
    binaryMissingDoc:
      "docs/operate/troubleshooting.md#desktop-uiabinary_missing",
    startupDoc: "docs/operate/troubleshooting.md#desktop-uiastartup_failed",
  });
}

async function checkLinuxAtspi(): Promise<ComputeDoctorCheck> {
  if (platform() !== "linux")
    return skip("desktop-atspi", "sidecar", "host is not Linux");
  return probeSidecar({
    transport: "desktop-atspi",
    name: "sidecar",
    sidecarName: "unicli-atspi",
    binaryMissingDoc:
      "docs/operate/troubleshooting.md#desktop-atspibinary_missing",
    startupDoc: "docs/operate/troubleshooting.md#desktop-atspidbus_blocked",
  });
}

async function probeSidecar(opts: {
  transport: string;
  name: string;
  sidecarName: SidecarName;
  binaryMissingDoc: string;
  startupDoc: string;
}): Promise<ComputeDoctorCheck> {
  const resolved = resolveSidecarBinary(opts.sidecarName);
  try {
    await execFileP(resolved.command, ["--version-probe"], { timeout: 5_000 });
  } catch (error) {
    return fail(
      opts.transport,
      opts.name,
      `sidecar binary unavailable: ${errorMessage(error)}`,
      {
        message: "Install the native sidecar package for this platform.",
        command: "unicli doctor compute --install",
        doc: opts.binaryMissingDoc,
      },
    );
  }

  const client = new StdioSidecarClient(resolved.command, [], {
    env: process.env,
  });
  try {
    await client.call("ping", {});
    return pass(
      opts.transport,
      opts.name,
      `${resolved.command} responded to ping (${resolved.source})`,
    );
  } catch (error) {
    return fail(opts.transport, opts.name, errorMessage(error), {
      message: "Inspect sidecar startup with tracing enabled.",
      command: "UNICLI_TRACE=1 unicli doctor compute",
      doc: opts.startupDoc,
    });
  } finally {
    await client.close();
  }
}

async function checkCdp(): Promise<ComputeDoctorCheck> {
  try {
    const port = getCDPPort();
    const available = await isCDPAvailable(port);
    if (available) {
      return pass(
        "cdp-browser",
        "default port",
        `CDP reachable on port ${port}`,
      );
    }
    return warn(
      "cdp-browser",
      "default port",
      `CDP not reachable on port ${port}`,
      {
        message:
          "Start the browser transport before CDP-backed compute actions.",
        command: "unicli browser start",
        doc: "docs/operate/troubleshooting.md#cdp-browserattach_failed",
      },
    );
  } catch (error) {
    return warn("cdp-browser", "default port", errorMessage(error), {
      message: "Start the browser transport before CDP-backed compute actions.",
      command: "unicli browser start",
      doc: "docs/operate/troubleshooting.md#cdp-browserattach_failed",
    });
  }
}

async function checkSubprocessLauncher(): Promise<ComputeDoctorCheck> {
  const launcher = launcherForPlatform(platform() as NodeJS.Platform);
  try {
    await execFileP(launcher.probeCommand, launcher.probeArgs, {
      timeout: 5_000,
    });
    return pass(
      "subprocess",
      "launcher",
      `${launcher.displayName} launcher available`,
    );
  } catch (error) {
    return fail(
      "subprocess",
      "launcher",
      `${launcher.displayName} launcher unavailable: ${errorMessage(error)}`,
      launcher.remedy,
    );
  }
}

function launcherForPlatform(hostPlatform: NodeJS.Platform): {
  displayName: string;
  probeCommand: string;
  probeArgs: string[];
  remedy: Remedy;
} {
  if (hostPlatform === "win32") {
    return {
      displayName: "PowerShell Start-Process",
      probeCommand: "powershell.exe",
      probeArgs: ["-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      remedy: {
        message:
          "Install or repair Windows PowerShell so compute launch can start apps.",
        doc: "docs/operate/troubleshooting.md#subprocesslauncher",
      },
    };
  }
  if (hostPlatform === "linux") {
    return {
      displayName: "gtk-launch",
      probeCommand: "which",
      probeArgs: ["gtk-launch"],
      remedy: {
        message:
          "Install GTK desktop utilities so compute launch can start desktop apps.",
        command: "sudo apt-get install libgtk-3-bin",
        doc: "docs/operate/troubleshooting.md#subprocesslauncher",
      },
    };
  }
  return {
    displayName: "macOS open",
    probeCommand: "which",
    probeArgs: ["open"],
    remedy: {
      message: "Restore the macOS open launcher at /usr/bin/open.",
      doc: "docs/operate/troubleshooting.md#subprocesslauncher",
    },
  };
}

function checkVisualBackend(): ComputeDoctorCheck {
  const keys = [
    "VISUAL_BACKEND",
    "VISUAL_BACKEND_ENDPOINT",
    "VISUAL_BACKEND_API_KEY",
  ];
  const present = keys.filter((key) => Boolean(process.env[key]));
  if (present.length > 0) {
    return pass(
      "visual",
      "backend",
      `backend env present: ${present.join(", ")}`,
    );
  }
  return warn("visual", "backend", "no visual backend configuration found", {
    message:
      "Set VISUAL_BACKEND_ENDPOINT and VISUAL_BACKEND_API_KEY for explicitly selected visual operations.",
    doc: "docs/operate/troubleshooting.md#visualno_backend",
  });
}

function printComputeDoctor(
  report: ComputeDoctorReport,
  opts: ComputeDoctorOptions,
): void {
  console.log(
    chalk.bold(
      `UNICLI Compute Doctor - host: ${report.host.platform}/${report.host.arch}`,
    ),
  );
  console.log("");
  for (const check of report.checks) {
    const marker = markerFor(check.status);
    console.log(
      `${marker} ${check.transport.padEnd(14)} ${check.name.padEnd(18)} ${check.detail}`,
    );
    if (check.remedy && (check.status === "fail" || opts.install)) {
      console.log(`    ${check.remedy.message}`);
      if (check.remedy.command) console.log(`    Run: ${check.remedy.command}`);
      if (check.remedy.deeplink)
        console.log(`    Open: ${check.remedy.deeplink}`);
    }
  }
  if (opts.install) {
    printInstallActions(report.installActions ?? []);
  }
  console.log("");
  const label =
    report.issueCount === 0
      ? chalk.green("0 blocking issues")
      : chalk.red(`${report.issueCount} blocking issue(s)`);
  console.log(`Result: ${label}. Use --json for machine output.`);
}

async function installMissingSidecars(
  report: ComputeDoctorReport,
): Promise<ComputeDoctorInstallAction[]> {
  const sidecarName = sidecarNameForPlatform(report.host.platform);
  const packageName = sidecarName
    ? packageNameForSidecar(sidecarName, report.host.platform, report.host.arch)
    : undefined;
  if (!packageName) return [];
  const missing = report.checks.some(
    (check) =>
      check.status === "fail" &&
      (check.transport === "desktop-uia" ||
        check.transport === "desktop-atspi"),
  );
  if (!missing) return [];

  const args = ["install", "-g", packageName];
  const command = `npm ${args.join(" ")}`;
  try {
    await execFileP("npm", args, { timeout: 300_000 });
    return [
      {
        transport: packageName.includes("uia")
          ? "desktop-uia"
          : "desktop-atspi",
        packageName,
        command,
        ok: true,
        detail: "installed",
      },
    ];
  } catch (error) {
    return [
      {
        transport: packageName.includes("uia")
          ? "desktop-uia"
          : "desktop-atspi",
        packageName,
        command,
        ok: false,
        detail: errorMessage(error),
      },
    ];
  }
}

function printInstallActions(actions: readonly ComputeDoctorInstallAction[]) {
  if (actions.length === 0) {
    console.log("");
    console.log(chalk.dim("No matching sidecar install action needed."));
    return;
  }

  console.log("");
  for (const action of actions) {
    const marker = action.ok ? chalk.green("installed") : chalk.red("failed");
    console.log(
      `${action.transport.padEnd(14)} ${marker} ${action.packageName}`,
    );
    console.log(`    $ ${action.command}`);
    if (!action.ok) console.log(`    ${action.detail}`);
  }
}

function sidecarNameForPlatform(
  hostPlatform: NodeJS.Platform,
): SidecarName | undefined {
  if (hostPlatform === "win32") return "unicli-uia";
  if (hostPlatform === "linux") return "unicli-atspi";
  return undefined;
}

function pass(
  transport: string,
  name: string,
  detail: string,
): ComputeDoctorCheck {
  return { name, transport, status: "ok", ok: true, detail };
}

function warn(
  transport: string,
  name: string,
  detail: string,
  remedy?: Remedy,
): ComputeDoctorCheck {
  return { name, transport, status: "warn", ok: true, detail, remedy };
}

function skip(
  transport: string,
  name: string,
  detail: string,
): ComputeDoctorCheck {
  return { name, transport, status: "skip", ok: true, detail };
}

function fail(
  transport: string,
  name: string,
  detail: string,
  remedy: Remedy,
): ComputeDoctorCheck {
  return { name, transport, status: "fail", ok: false, detail, remedy };
}

function markerFor(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return chalk.green("OK");
    case "warn":
      return chalk.yellow("!!");
    case "fail":
      return chalk.red("XX");
    case "skip":
      return chalk.dim("--");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
