import type { Command } from "commander";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, stat } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCDPPort, isCDPAvailable } from "../browser/launcher.js";
import { VERSION } from "../constants.js";
import {
  packageNameForSidecar,
  resolveSidecarBinary,
  type SidecarName,
} from "../transport/sidecar-binary.js";
import { StdioSidecarClient } from "../transport/sidecar.js";

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
}

export function registerDoctorComputeCommand(doctor: Command): void {
  doctor
    .command("compute")
    .description("Per-transport health probe for the compute family")
    .option("--json", "Machine-readable output")
    .option("--install", "Install the matching native sidecar when missing")
    .action(async (opts: ComputeDoctorOptions) => {
      const report = await runComputeDoctor();
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

export async function runComputeDoctor(): Promise<ComputeDoctorReport> {
  const checks = [
    await checkSwift(),
    await checkMacAccessibility(),
    await checkMacScreenRecording(),
    await checkWindowsUia(),
    await checkLinuxAtspi(),
    await checkSubprocessLauncher(),
    await checkCdp(),
    checkCuaBackend(),
  ];
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

function checkCuaBackend(): ComputeDoctorCheck {
  const keys = ["ANTHROPIC_API_KEY", "TRYCUA_API_KEY", "OPENAI_API_KEY"];
  const present = keys.filter((key) => Boolean(process.env[key]));
  if (present.length > 0) {
    return pass("cua", "backend", `backend env present: ${present.join(", ")}`);
  }
  return warn("cua", "backend", "no CUA backend API key found", {
    message:
      "Set a supported backend key if screenshot/VLM fallback is needed.",
    doc: "docs/operate/troubleshooting.md#cuano_backend",
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
