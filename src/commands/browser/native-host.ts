/**
 * @owner       src/commands/browser/native-host.ts
 * @does        Register browser native-host install/status/uninstall/extension-path commands with structured output.
 * @needs       commander, src/browser/native-host-install.ts, src/output/formatter.ts, src/output/envelope.ts
 * @feeds       src/commands/browser/index.ts
 * @breaks      Emits structured native-host errors and nonzero status when a selected registration is missing or invalid.
 * @invariants  Commands never launch Chrome; installation is explicit; status distinguishes ready, missing, and invalid registration.
 * @side-effects Explicit install/uninstall commands mutate per-user NativeMessagingHosts registration; status/path are read-only.
 * @perf        O(selected browsers) filesystem/registry operations.
 * @concurrency Installer atomic replacement semantics own concurrent writes.
 * @test        tests/unit/native-host-install.test.ts, tests/unit/commands/browser.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { Command } from "commander";

import {
  chromeExtensionDirectory,
  installChromeNativeHost,
  inspectChromeNativeHost,
  uninstallChromeNativeHost,
  type ChromeNativeHostBrowser,
  type ChromeNativeHostStatus,
} from "../../browser/native-host-install.js";
import { CHROME_EXTENSION_ID } from "../../browser/chrome-native-protocol.js";
import { makeCtx } from "../../output/envelope.js";
import { detectFormat, format } from "../../output/formatter.js";
import type { OutputFormat } from "../../types.js";

interface NativeHostCommandOptions {
  browser: string;
  all?: boolean;
  json?: boolean;
}

const SUPPORTED_BROWSERS: ChromeNativeHostBrowser[] = [
  "chrome",
  "chromium",
  "brave",
  "edge",
];

export function registerBrowserNativeHostCommands(
  browser: Command,
  program: Command,
): void {
  const nativeHost = browser
    .command("native-host")
    .description("Manage the authenticated Chrome Native Messaging host");

  nativeHost
    .command("status")
    .description("Inspect native-host registration without opening Chrome")
    .option("--browser <browser>", browserOptionDescription(), "chrome")
    .option("--all", "Inspect every supported Chromium browser")
    .option("--json", "JSON output (alias for -f json)")
    .action((options: NativeHostCommandOptions) => {
      runNativeHostCommand(program, "status", options, (browsers) =>
        inspectChromeNativeHost({ browsers }),
      );
    });

  nativeHost
    .command("install")
    .description("Install the per-user native-host registration")
    .option("--browser <browser>", browserOptionDescription(), "chrome")
    .option("--all", "Install for every supported Chromium browser")
    .option("--json", "JSON output (alias for -f json)")
    .action((options: NativeHostCommandOptions) => {
      runNativeHostCommand(program, "install", options, (browsers) =>
        installChromeNativeHost({ browsers }),
      );
    });

  nativeHost
    .command("uninstall")
    .description("Remove the selected per-user native-host registration")
    .option("--browser <browser>", browserOptionDescription(), "chrome")
    .option("--all", "Remove every supported Chromium registration")
    .option("--json", "JSON output (alias for -f json)")
    .action((options: NativeHostCommandOptions) => {
      runNativeHostCommand(program, "uninstall", options, (browsers) =>
        uninstallChromeNativeHost({ browsers }),
      );
    });

  nativeHost
    .command("extension-path")
    .description("Print the unpacked Uni-CLI Chrome extension directory")
    .option("--json", "JSON output (alias for -f json)")
    .action((options: { json?: boolean }) => {
      const startedAt = Date.now();
      const ctx = makeCtx("browser.native_host.extension_path", startedAt);
      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(
          {
            extension_id: CHROME_EXTENSION_ID,
            extension_directory: chromeExtensionDirectory(),
          },
          undefined,
          commandFormat(program, options.json),
          ctx,
        ),
      );
    });
}

function runNativeHostCommand(
  program: Command,
  operation: "status" | "install" | "uninstall",
  options: NativeHostCommandOptions,
  execute: (browsers: ChromeNativeHostBrowser[]) => ChromeNativeHostStatus[],
): void {
  const startedAt = Date.now();
  const ctx = makeCtx(`browser.native_host.${operation}`, startedAt);
  const outputFormat = commandFormat(program, options.json);
  try {
    const browsers = selectedBrowsers(options);
    const registrations = execute(browsers);
    const ready = registrations.every(
      (registration) => registration.state === "ready",
    );
    ctx.duration_ms = Date.now() - startedAt;
    console.log(
      format(
        {
          operation,
          ready,
          extension_id: CHROME_EXTENSION_ID,
          extension_directory: chromeExtensionDirectory(),
          registrations,
        },
        undefined,
        outputFormat,
        ctx,
      ),
    );
    if (operation === "status" && !ready) process.exitCode = 1;
  } catch (error) {
    const tagged = error as Partial<{
      code: string;
      suggestion: string;
      retryable: boolean;
    }>;
    ctx.error = {
      code: tagged.code ?? "native_host_command_failed",
      message: error instanceof Error ? error.message : String(error),
      ...(tagged.suggestion ? { suggestion: tagged.suggestion } : {}),
      retryable: tagged.retryable ?? false,
    };
    ctx.duration_ms = Date.now() - startedAt;
    console.error(format(null, undefined, outputFormat, ctx));
    process.exitCode = 1;
  }
}

function selectedBrowsers(
  options: NativeHostCommandOptions,
): ChromeNativeHostBrowser[] {
  if (options.all === true) return SUPPORTED_BROWSERS;
  if (
    !SUPPORTED_BROWSERS.includes(options.browser as ChromeNativeHostBrowser)
  ) {
    throw new Error(
      `Unsupported Chromium browser ${options.browser}; expected ${SUPPORTED_BROWSERS.join(", ")}`,
    );
  }
  return [options.browser as ChromeNativeHostBrowser];
}

function commandFormat(program: Command, json?: boolean): OutputFormat {
  return detectFormat(
    json ? "json" : (program.opts().format as OutputFormat | undefined),
  );
}

function browserOptionDescription(): string {
  return `Browser registration (${SUPPORTED_BROWSERS.join("|")})`;
}
