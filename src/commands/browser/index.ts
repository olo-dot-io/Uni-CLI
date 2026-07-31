/**
 * @owner       src/commands/browser/index.ts
 * @does        Compose broker lifecycle, browser operation, native-host, adapter-authoring, local-profile inventory, and explicit cookie persistence commands.
 * @needs       commander, src/commands/browser lifecycle/actions/adapter/native-host, src/browser/local-profiles, src/engine/chromium-cookies/cookie-storage, output
 * @feeds       src/cli.ts and the public `unicli browser` command tree
 * @breaks      Provider/lifecycle/profile/cookie errors emit structured envelopes and nonzero exits without direct-CDP or legacy transport fallback.
 * @invariants  Browser ownership routes through the broker; profiles never expose raw cookies; cookie persistence is explicit and owner-protected.
 * @side-effects Registers commands, reads local browser profiles/cookies, and explicitly writes cookie files when requested.
 * @perf        Command registration is constant-time; profile/cookie reads are bounded by local browser databases.
 * @concurrency Runtime concurrency is broker-owned; cookie import is a read-only source operation followed by one atomic storage write.
 * @test        tests/unit/commands/browser.test.ts, tests/unit/browser-doctor.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { Command } from "commander";

import {
  applyBrowserOperatorRootOptions,
  registerBrowserOperatorSubcommands,
} from "./actions.js";
import { registerBrowserAdapterAuthoringSubcommands } from "./adapter.js";
import { registerBrowserLifecycleCommands } from "./lifecycle.js";
import { registerBrowserNativeHostCommands } from "./native-host.js";
import { authorizeBrowserCommand } from "./permission.js";
import {
  browserCookieIdForLocalProfile,
  detectLocalBrowserProfiles,
  requireLocalBrowserIdentity,
  resolveLocalBrowserProfile,
  type LocalBrowserProfile,
} from "../../browser/local-profiles.js";
import {
  ChromiumCookieError,
  readCookiesAsRecord,
} from "../../engine/chromium-cookies.js";
import { saveCookies } from "../../engine/cookie-storage.js";
import type { OutputFormat } from "../../types.js";
import { ExitCode } from "../../types.js";
import { detectFormat, format } from "../../output/formatter.js";
import { makeCtx } from "../../output/envelope.js";
import { mapErrorToExitCode } from "../../output/error-map.js";

export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command("browser")
    .description(
      "Operate shared broker-owned browser runtimes and Agent targets",
    );
  applyBrowserOperatorRootOptions(browser);
  registerBrowserLifecycleCommands(browser, program);
  registerProfileCommand(browser, program);
  registerCookieCommand(browser, program);
  registerBrowserAdapterAuthoringSubcommands(browser, program);
  registerBrowserNativeHostCommands(browser, program);
  registerBrowserOperatorSubcommands(browser, program, "browser");
}

function registerProfileCommand(browser: Command, program: Command): void {
  browser
    .command("profiles")
    .description("List local Chromium-family browser profiles without cookies")
    .option("--json", "JSON output (alias for -f json)")
    .action(async (options: { json?: boolean }) => {
      const startedAt = Date.now();
      const outputFormat = commandFormat(program, options.json);
      const context = makeCtx("browser.profiles", startedAt);
      try {
        await authorizeBrowserCommand(program, "browser", "profiles", {
          json: options.json === true,
        });
        const profiles = detectLocalBrowserProfiles();
        printCommandResult(
          program,
          "browser.profiles",
          {
            source: "local-filesystem",
            raw_cookie_values_returned: false,
            count: profiles.length,
            profiles,
          },
          options.json,
          startedAt,
        );
      } catch (error) {
        emitBrowserCommandFailure({
          context,
          startedAt,
          outputFormat,
          error,
          fallbackCode: "browser_profiles_failed",
          fallbackSuggestion: "Repair local Chromium profile access and retry.",
        });
      }
    });
}

function registerCookieCommand(browser: Command, program: Command): void {
  browser
    .command("cookies <domain>")
    .description("Explicitly import and persist cookies from one local profile")
    .option(
      "--profile-id <id>",
      "Use a discovered profile from `unicli browser profiles --json`",
    )
    .option(
      "--save-as <site>",
      "Persist under a custom site name instead of the domain-derived name",
    )
    .action(
      async (
        domain: string,
        options: { profileId?: string; saveAs?: string },
      ) => {
        const startedAt = Date.now();
        const outputFormat = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );
        const context = makeCtx("browser.cookies", startedAt);
        try {
          await authorizeBrowserCommand(program, "browser", "cookies", {
            domain,
            profileId: options.profileId ?? null,
            saveAs: options.saveAs ?? null,
          });
          const profile = resolveCookieProfile(options.profileId);
          const browserId = browserCookieIdForLocalProfile(profile);
          if (!browserId) {
            throw new ChromiumCookieError(
              "browser_unsupported",
              `Cookie import is not supported for ${profile.browser_name}`,
            );
          }
          const cookies = readCookiesAsRecord({
            browser: browserId,
            domain,
            profile: profile.profile_dir,
            userDataDir: profile.user_data_dir,
          });
          if (Object.keys(cookies).length === 0) {
            context.error = {
              code: "auth_required",
              message: `No cookies found for ${domain} in ${profile.display_name}`,
              suggestion:
                "Sign in with the selected local browser profile and retry the explicit cookie import.",
              retryable: false,
              exit_code: ExitCode.AUTH_REQUIRED,
            };
            context.duration_ms = Date.now() - startedAt;
            console.error(format(null, undefined, outputFormat, context));
            process.exitCode = ExitCode.AUTH_REQUIRED;
            return;
          }
          const site = options.saveAs ?? domain.replace(/\./g, "-");
          const file = saveCookies(site, cookies);
          context.duration_ms = Date.now() - startedAt;
          console.log(
            format(
              {
                domain,
                site,
                profile_id: profile.id,
                cookie_count: Object.keys(cookies).length,
                cookie_names: Object.keys(cookies),
                raw_cookie_values_returned: false,
                file,
                persistence: "explicit",
                storage_format: "plaintext-json",
                directory_mode: process.platform === "win32" ? null : "0700",
                file_mode: process.platform === "win32" ? null : "0600",
              },
              undefined,
              outputFormat,
              context,
            ),
          );
        } catch (error) {
          emitBrowserCommandFailure({
            context,
            startedAt,
            outputFormat,
            error,
            fallbackCode:
              error instanceof ChromiumCookieError
                ? `cookie_${error.code.replaceAll("-", "_")}`
                : "browser_cookie_import_failed",
            fallbackSuggestion:
              "Run `unicli browser profiles --json`, select a readable signed-in profile, and retry.",
          });
        }
      },
    );
}

function resolveCookieProfile(profileId?: string): LocalBrowserProfile {
  const profile = profileId
    ? resolveLocalBrowserProfile(profileId)
    : requireLocalBrowserIdentity().profile;
  if (!profile) {
    throw new Error(
      profileId
        ? `Browser profile not found: ${profileId}`
        : "No local Chromium browser profile is available",
    );
  }
  return profile;
}

function printCommandResult(
  program: Command,
  command: string,
  result: Record<string, unknown>,
  jsonAlias: boolean | undefined,
  startedAt: number,
): void {
  const outputFormat = commandFormat(program, jsonAlias);
  const context = makeCtx(command, startedAt);
  context.duration_ms = Date.now() - startedAt;
  console.log(format(result, undefined, outputFormat, context));
}

function commandFormat(program: Command, jsonAlias = false): OutputFormat {
  return detectFormat(
    jsonAlias ? "json" : (program.opts().format as OutputFormat | undefined),
  );
}

function emitBrowserCommandFailure(input: {
  context: ReturnType<typeof makeCtx>;
  startedAt: number;
  outputFormat: OutputFormat;
  error: unknown;
  fallbackCode: string;
  fallbackSuggestion: string;
}): void {
  const tagged = input.error as Partial<{
    code: string;
    suggestion: string;
    retryable: boolean;
    exitCode: number;
    adapter_path: string;
    step: number;
    stage: string;
  }>;
  input.context.duration_ms = Date.now() - input.startedAt;
  input.context.error = {
    code: tagged.code ?? input.fallbackCode,
    message:
      input.error instanceof Error ? input.error.message : String(input.error),
    suggestion: tagged.suggestion ?? input.fallbackSuggestion,
    adapter_path: tagged.adapter_path ?? "src/commands/browser/index.ts",
    step: tagged.step ?? 0,
    ...(tagged.stage ? { stage: tagged.stage } : {}),
    retryable: tagged.retryable ?? false,
  };
  console.error(format(null, undefined, input.outputFormat, input.context));
  process.exitCode = tagged.exitCode ?? mapErrorToExitCode(input.error);
}
