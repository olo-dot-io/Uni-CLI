/**
 * @owner   src::commands::upgrade
 * @does    Check the npm release, offer an interactive Y/N choice, or install one exact Uni-CLI version unattended.
 * @needs   update cache worker, update preferences, package-manager subprocess, output envelopes.
 * @feeds   `unicli upgrade`, Agent update next actions, and release recovery workflows.
 * @breaks  Wrong install-method detection can update a different installation; non-TTY prompts can stall Agents.
 * @invariants Network checks are explicit, non-TTY updates require --yes, and installers receive an exact validated version without a shell.
 * @side-effects May query npm, write update state, and replace a global npm, pnpm, or Bun installation.
 * @perf    Registry lookup has a three-second deadline; installer duration belongs to the selected package manager.
 * @concurrency The package manager owns installation locking; preference writes are atomic.
 * @test    tests/unit/commands/upgrade.test.ts
 * @stability public CLI command.
 * @since   2026-08-10
 */

import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { VERSION } from "../constants.js";
import { clearActiveUpdateNotice } from "../core/update-notice.js";
import {
  isNewer,
  readUpdateCache,
  updateCachePath,
} from "../engine/update-check.js";
import { refreshUpdateCache } from "../engine/update-check-worker.js";
import {
  AUTO_UPDATE_LEASE_TTL_MS,
  readAutomaticUpdateState,
} from "../engine/update-auto.js";
import {
  detectUpdatePackageManager,
  runPackageManagerInstall,
  updateInstallCommand,
  type InstallResult,
  type UpdatePackageManager,
} from "../engine/update-install.js";
import {
  clearUpdatePreferences,
  deferUpdate,
  dismissUpdate,
  readUpdatePreferences,
  setAutomaticUpdates,
  updateSuppression,
} from "../engine/update-preferences.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

export {
  detectUpdatePackageManager,
  updateInstallCommand,
  type UpdatePackageManager,
};

interface UpgradeArgs {
  check: boolean;
  yes: boolean;
  no: boolean;
  skipVersion: boolean;
  automaticUpdates?: boolean;
  help: boolean;
  packageManager?: UpdatePackageManager;
  format?: OutputFormat;
}

interface LatestRelease {
  latest: string;
  source: "registry" | "cache";
}

export interface UpgradeCommandRuntime {
  env?: NodeJS.ProcessEnv;
  stdinIsTTY?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  prompt?: (question: string) => Promise<string>;
  resolveLatest?: () => Promise<LatestRelease>;
  install?: (
    manager: UpdatePackageManager,
    latest: string,
  ) => Promise<InstallResult>;
  scriptPath?: string;
  now?: () => number;
}

const HELP = `Usage: unicli upgrade [options]

Check for a newer Uni-CLI release and choose whether to install it.

Options:
  --check                      Check only and return structured version status
  --yes                        Install without prompting
  --no                         Remind again after 24 hours
  --skip-version               Hide this exact release and resume on the next one
  --auto-update                Enable automatic updates for persistent installations
  --no-auto-update             Keep future updates on the explicit Y/N path
  --package-manager <manager>  npm, pnpm, or bun
  -f, --format <format>        json, yaml, md, csv, or compact
  -h, --help                   Show this help
`;

export function parseUpgradeArgs(args: readonly string[]): UpgradeArgs {
  const parsed: UpgradeArgs = {
    check: false,
    yes: false,
    no: false,
    skipVersion: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") parsed.check = true;
    else if (argument === "--yes" || argument === "-y") parsed.yes = true;
    else if (argument === "--no" || argument === "-n") parsed.no = true;
    else if (argument === "--skip-version") parsed.skipVersion = true;
    else if (argument === "--auto-update") parsed.automaticUpdates = true;
    else if (argument === "--no-auto-update") parsed.automaticUpdates = false;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--package-manager") {
      parsed.packageManager = parsePackageManager(args[index + 1]);
      index += 1;
    } else if (argument.startsWith("--package-manager=")) {
      parsed.packageManager = parsePackageManager(
        argument.slice("--package-manager=".length),
      );
    } else if (argument === "-f" || argument === "--format") {
      parsed.format = parseOutputFormat(args[index + 1]);
      index += 1;
    } else if (argument.startsWith("--format=")) {
      parsed.format = parseOutputFormat(argument.slice("--format=".length));
    } else {
      throw new Error(`Unknown upgrade option ${argument}`);
    }
  }
  const decisions = [parsed.yes, parsed.no, parsed.skipVersion].filter(
    Boolean,
  ).length;
  if (decisions > 1) {
    throw new Error("Choose only one of --yes, --no, or --skip-version");
  }
  if (parsed.check && decisions > 0) {
    throw new Error("--check cannot be combined with an update choice");
  }
  if (
    parsed.automaticUpdates !== undefined &&
    (parsed.check || decisions > 0)
  ) {
    throw new Error(
      "Automatic-update settings cannot be combined with a release choice",
    );
  }
  return parsed;
}

function parsePackageManager(value: string | undefined): UpdatePackageManager {
  if (value === "npm" || value === "pnpm" || value === "bun") return value;
  throw new Error("--package-manager must be npm, pnpm, or bun");
}

function parseOutputFormat(value: string | undefined): OutputFormat {
  if (
    value === "json" ||
    value === "yaml" ||
    value === "md" ||
    value === "csv" ||
    value === "compact"
  ) {
    return value;
  }
  throw new Error("--format must be json, yaml, md, csv, or compact");
}

export async function runUpgradeCommand(
  args: readonly string[],
  runtime: UpgradeCommandRuntime = {},
): Promise<number> {
  const startedAt = Date.now();
  const env = runtime.env ?? process.env;
  const stdout =
    runtime.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr =
    runtime.stderr ?? ((text: string) => process.stderr.write(text));
  let parsed: UpgradeArgs;
  try {
    parsed = parseUpgradeArgs(args);
  } catch (error) {
    emitUpgradeError(
      error instanceof Error ? error.message : String(error),
      "Run `unicli upgrade --help` for valid choices.",
      detectFormat(),
      startedAt,
      stderr,
    );
    return 64;
  }
  if (parsed.help) {
    stdout(HELP);
    return 0;
  }

  const outputFormat = detectFormat(parsed.format);
  if (parsed.automaticUpdates !== undefined) {
    setAutomaticUpdates(parsed.automaticUpdates, env);
    emitUpgradeData(
      {
        automatic_updates: parsed.automaticUpdates ? "enabled" : "disabled",
        status: "preferences_updated",
        environment_override: "UNICLI_AUTO_UPDATE=0|1",
      },
      outputFormat,
      startedAt,
      stdout,
    );
    return 0;
  }
  let release: LatestRelease;
  try {
    release = runtime.resolveLatest
      ? await runtime.resolveLatest()
      : await resolveLatestRelease(env);
  } catch (error) {
    emitUpgradeError(
      error instanceof Error ? error.message : String(error),
      "Check the network or proxy, then run `unicli upgrade --check` again.",
      outputFormat,
      startedAt,
      stderr,
    );
    return 69;
  }

  const preferences = readUpdatePreferences(env);
  const suppression = updateSuppression(
    release.latest,
    preferences,
    (runtime.now ?? Date.now)(),
  );
  const available = isNewer(release.latest, VERSION);
  const manager =
    parsed.packageManager ??
    detectUpdatePackageManager(
      runtime.scriptPath ?? fileURLToPath(import.meta.url),
    );
  const automaticState = readAutomaticUpdateState(env);
  const common = {
    current: VERSION,
    latest: release.latest,
    update_available: available,
    source: release.source,
    package_manager: manager ?? "unknown",
    suppressed: suppression ?? "none",
    automatic_updates:
      preferences.automaticUpdates === undefined
        ? "agent_default"
        : preferences.automaticUpdates
          ? "enabled"
          : "disabled",
    automatic_update_status:
      automaticState?.version === release.latest
        ? automaticState.status
        : "none",
    release_notes: `https://github.com/olo-dot-io/Uni-CLI/releases/tag/v${release.latest}`,
  };

  if (parsed.check || !available) {
    if (!available) clearActiveUpdateNotice();
    emitUpgradeData(
      {
        ...common,
        status: available ? "update_available" : "up_to_date",
        confirmation_required: false,
      },
      outputFormat,
      startedAt,
      stdout,
    );
    return 0;
  }

  if (
    parsed.yes &&
    automaticState?.version === release.latest &&
    (automaticState.status === "scheduled" ||
      automaticState.status === "running") &&
    (runtime.now ?? Date.now)() - automaticState.startedAt <
      AUTO_UPDATE_LEASE_TTL_MS
  ) {
    emitUpgradeData(
      {
        ...common,
        status: "automatic_update_running",
        confirmation_required: false,
        next_command: "unicli --version",
      },
      outputFormat,
      startedAt,
      stdout,
    );
    return 0;
  }

  if (parsed.no) {
    deferUpdate(release.latest, env, (runtime.now ?? Date.now)());
    clearActiveUpdateNotice();
    emitUpgradeData(
      {
        ...common,
        status: "remind_later",
        remind_after_hours: 24,
      },
      outputFormat,
      startedAt,
      stdout,
    );
    return 0;
  }

  if (parsed.skipVersion) {
    dismissUpdate(release.latest, env);
    clearActiveUpdateNotice();
    emitUpgradeData(
      { ...common, status: "skipped_until_next_version" },
      outputFormat,
      startedAt,
      stdout,
    );
    return 0;
  }

  let approved = parsed.yes;
  if (!approved && (runtime.stdinIsTTY ?? process.stdin.isTTY)) {
    approved = await promptForApproval(
      `Upgrade Uni-CLI ${VERSION} to ${release.latest} now? [Y/n] `,
      runtime.prompt,
    );
    if (!approved) {
      deferUpdate(release.latest, env, (runtime.now ?? Date.now)());
      clearActiveUpdateNotice();
      emitUpgradeData(
        {
          ...common,
          status: "remind_later",
          remind_after_hours: 24,
        },
        outputFormat,
        startedAt,
        stdout,
      );
      return 0;
    }
  }

  if (!approved) {
    emitUpgradeData(
      {
        ...common,
        status: "confirmation_required",
        confirmation_required: true,
        choices: {
          yes: "unicli upgrade --yes",
          no: "unicli upgrade --no",
          skip_version: "unicli upgrade --skip-version",
        },
      },
      outputFormat,
      startedAt,
      stdout,
    );
    return 0;
  }

  if (!manager) {
    emitUpgradeError(
      "The current installation is ephemeral, so Uni-CLI cannot replace it safely.",
      `Install the exact release with \`npm install --global @zenalexa/unicli@${release.latest}\`.`,
      outputFormat,
      startedAt,
      stderr,
    );
    return 69;
  }

  const install =
    runtime.install ??
    ((selectedManager, selectedVersion) =>
      runPackageManagerInstall(selectedManager, selectedVersion, env));
  const result = await install(manager, release.latest);
  const installCommand = updateInstallCommand(manager, release.latest).display;
  if (result.exitCode !== 0) {
    emitUpgradeError(
      `The package manager exited with code ${result.exitCode}.${result.output ? ` ${result.output}` : ""}`,
      `Fix the package-manager error, then run \`${installCommand}\`.`,
      outputFormat,
      startedAt,
      stderr,
    );
    return result.exitCode || 1;
  }

  clearUpdatePreferences(env);
  clearActiveUpdateNotice();
  emitUpgradeData(
    {
      ...common,
      status: "updated",
      installed: release.latest,
      install_command: installCommand,
      next_command: "unicli --version",
    },
    outputFormat,
    startedAt,
    stdout,
  );
  return 0;
}

async function resolveLatestRelease(
  env: NodeJS.ProcessEnv,
): Promise<LatestRelease> {
  try {
    const refreshed = await refreshUpdateCache({
      registryUrl: env.UNICLI_UPDATE_CHECK_URL,
      cachePath: updateCachePath(env),
    });
    return { latest: refreshed.latest, source: "registry" };
  } catch (error) {
    const cached = readUpdateCache(env);
    if (cached) return { latest: cached.latest, source: "cache" };
    throw error;
  }
}

async function promptForApproval(
  question: string,
  prompt?: (question: string) => Promise<string>,
): Promise<boolean> {
  const ask =
    prompt ??
    (async (message: string) => {
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await input.question(message);
      } finally {
        input.close();
      }
    });
  for (;;) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    question = "Enter Y to update or N to remind later. [Y/n] ";
  }
}

function emitUpgradeData(
  data: Record<string, unknown>,
  outputFormat: OutputFormat,
  startedAt: number,
  stdout: (text: string) => void,
): void {
  const ctx = makeCtx("core.upgrade", startedAt, { surface: "system" });
  stdout(`${format(data, undefined, outputFormat, ctx)}\n`);
}

function emitUpgradeError(
  message: string,
  suggestion: string,
  outputFormat: OutputFormat,
  startedAt: number,
  stderr: (text: string) => void,
): void {
  const ctx = makeCtx("core.upgrade", startedAt, { surface: "system" });
  ctx.error = {
    code: "update_failed",
    message,
    suggestion,
    retryable: true,
  };
  stderr(`${format(null, undefined, outputFormat, ctx)}\n`);
}
