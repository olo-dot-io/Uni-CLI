/**
 * @owner   src/commands/browser/index.ts
 * @does    Register browser root commands for Chrome lifecycle, CDP status, doctor reports, local profiles, cookies, sessions, actions, and adapter authoring.
 * @needs   commander, chalk, src/browser launcher/CDP/daemon/workspace/local-profiles/profile-seed/doctor, ./actions, ./adapter, output formatter, src/engine cookie-extractor/chromium-cookies
 * @feeds   src/cli.ts, tests/unit/commands/browser.test.ts
 * @breaks  Chrome, CDP, daemon, profile seed, and cookie failures propagate through command errors and stderr. No fallback.
 * @invariants Browser start reports attach/seeded/ephemeral source, refreshes only stopped automation profiles, and never substitutes an empty profile after seed failure.
 * @side-effects May launch Chrome, seed Uni-CLI automation profile directories, save cookies, and write adapter skeletons.
 * @perf    Browser lifecycle probes are bounded and profile lists avoid raw cookie values.
 * @concurrency Launcher owns seed locks; command layer avoids launching a second Chrome for a live selected profile.
 * @test    tests/unit/commands/browser.test.ts
 * @stability experimental
 * @since   2026-06-29
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  findAvailableCDPPort,
  findChrome,
  isCDPAvailable,
  launchChrome,
  getCDPPort,
  type ChromeLaunchOptions,
} from "../../browser/launcher.js";
import { CDPClient, getRemoteEndpoint } from "../../browser/cdp-client.js";
import {
  bindCurrentTab,
  fetchDaemonPortConflict,
  fetchDaemonStatus,
  listSessions,
} from "../../browser/daemon-client.js";
import {
  applyBrowserOperatorRootOptions,
  registerBrowserOperatorSubcommands,
  withBrowserOperatorEnv,
} from "./actions.js";
import { registerBrowserAdapterAuthoringSubcommands } from "./adapter.js";
import { resolveBrowserWorkspace } from "../../browser/workspace.js";
import {
  automationDefaultUserDataDir,
  automationUserDataDirForProfile,
  browserCookieIdForLocalProfile,
  detectLocalBrowserProfiles,
  isProcessVerifiedDebugPort,
  readProcessDebugTargetForPort,
  readUserDataDirDebugPort,
  resolveLocalBrowserProfile,
  resolvePreferredLocalBrowserProfile,
  type LocalBrowserProfile,
} from "../../browser/local-profiles.js";
import { runBrowserDoctor } from "../../browser/doctor.js";
import {
  inspectAutomationProfileSeed,
  isBrowserEphemeralRequested,
  isEphemeralAutomationUserDataDir,
  isRunningSeedIdentityUsable,
} from "../../browser/profile-seed.js";
import {
  ChromiumCookieError,
  readCookiesAsRecord,
} from "../../engine/chromium-cookies.js";
import { detectFormat, format } from "../../output/formatter.js";
import { makeCtx } from "../../output/envelope.js";
import type { AgentNextAction } from "../../output/envelope.js";
import type { OutputFormat } from "../../types.js";

export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command("browser")
    .description("Manage and operate browser automation sessions");

  applyBrowserOperatorRootOptions(browser);

  // unicli browser start
  browser
    .command("start")
    .description("Start or connect to Chrome with CDP enabled")
    .option("--port <port>", "CDP port", String(getCDPPort()))
    .option(
      "--profile",
      "Use dedicated automation profile (~/.unicli/chrome-profile)",
    )
    .option(
      "--profile-id <id>",
      "Use a discovered logged-in browser profile from `unicli browser profiles --json`",
    )
    .option("--headless", "Launch in headless mode (for CI)")
    .option(
      "--ephemeral",
      "Launch a clean empty temporary profile instead of attaching or seeding login state",
    )
    .option(
      "--refresh-profile",
      "Force a stopped automation profile to be reseeded from the selected local browser profile",
    )
    .action(
      async (opts: {
        port: string;
        profile?: boolean;
        profileId?: string;
        headless?: boolean;
        ephemeral?: boolean;
        refreshProfile?: boolean;
      }) => {
        const port = parseInt(opts.port, 10);
        const ephemeral =
          opts.ephemeral === true || isBrowserEphemeralRequested(process.env);
        if (ephemeral && opts.refreshProfile === true) {
          console.error(
            chalk.red(
              "--refresh-profile cannot be combined with --ephemeral because ephemeral profiles are intentionally empty.",
            ),
          );
          process.exitCode = 1;
          return;
        }
        const remote = getRemoteEndpoint();
        if (!ephemeral && remote && opts.refreshProfile === true) {
          console.error(
            chalk.red(
              "--refresh-profile applies only to local seeded automation profiles; UNICLI_CDP_ENDPOINT is configured.",
            ),
          );
          process.exitCode = 1;
          return;
        }
        if (!ephemeral && remote) {
          try {
            await verifyRemoteEndpoint(remote.endpoint, remote.headers);
            console.log(chalk.green("Remote CDP endpoint connected"));
            console.log(
              chalk.dim(`Source: attach (${redactEndpoint(remote.endpoint)})`),
            );
            console.log(
              chalk.dim(
                "Browser commands will attach through UNICLI_CDP_ENDPOINT.",
              ),
            );
          } catch (err) {
            console.error(
              chalk.red(
                `Remote CDP endpoint is not reachable: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
            process.exitCode = 1;
          }
          return;
        }

        const localProfile = ephemeral
          ? null
          : opts.profileId
            ? resolveLocalBrowserProfile(opts.profileId)
            : resolvePreferredLocalBrowserProfile();
        if (opts.profileId && !localProfile) {
          console.error(
            chalk.red(`Browser profile not found: ${opts.profileId}`),
          );
          console.log(chalk.dim("Run: unicli browser profiles --json"));
          process.exitCode = 1;
          return;
        }

        const liveProfilePort = localProfile
          ? await liveRecordedProfilePort(localProfile)
          : null;
        if (localProfile && liveProfilePort !== null) {
          console.log(
            chalk.green(
              `Chrome CDP already available for ${localProfile.display_name} on port ${String(liveProfilePort)}`,
            ),
          );
          console.log(chalk.dim("Source: attach live local browser profile"));
          await printTargetSummary(liveProfilePort);
          return;
        }

        const chromePath = localProfile?.browser_path_exists
          ? localProfile.browser_path
          : findChrome();
        if (!chromePath) {
          console.error(
            chalk.red(
              "Chrome not found. Install Google Chrome or set CHROME_PATH env var.",
            ),
          );
          process.exitCode = 1;
          return;
        }

        console.log(chalk.dim(`Found Chrome: ${chromePath}`));
        if (ephemeral) {
          console.log(
            chalk.yellow(
              "Warning: launching an explicit ephemeral browser with an empty temporary profile.",
            ),
          );
        } else if (localProfile) {
          console.log(
            chalk.dim(
              `Login source profile: ${localProfile.display_name} (${localProfile.id})`,
            ),
          );
        }
        console.log(chalk.dim(`Launching with CDP on port ${String(port)}...`));

        try {
          const launchPort = ephemeral
            ? await findAvailableCDPPort(port)
            : port;
          if (ephemeral && launchPort !== port) {
            console.error(
              chalk.dim(
                `Port ${String(port)} already has a local listener; launching ephemeral Chrome on ${String(launchPort)} instead.`,
              ),
            );
          }
          const browserRootOpts = browser.opts() as { focus?: boolean };
          const actualPort = await launchChrome(launchPort, {
            profile: opts.profile,
            headless: opts.headless,
            ephemeral,
            refreshProfile: opts.refreshProfile === true,
            ...(opts.profileId && localProfile
              ? launchOptionsForProfile(localProfile)
              : {}),
            ...(browserRootOpts.focus === true ? { background: false } : {}),
          });
          console.log(
            chalk.green(`Chrome CDP ready on port ${String(actualPort)}`),
          );
          printLaunchSource(
            ephemeral,
            localProfile,
            opts.profileId !== undefined,
          );
          await printTargetSummary(actualPort);
        } catch (err) {
          console.error(
            chalk.red(err instanceof Error ? err.message : String(err)),
          );
          process.exitCode = 1;
        }
      },
    );

  // unicli browser status
  browser
    .command("status")
    .description("Check Chrome CDP connection status")
    .option("--port <port>", "CDP port", String(getCDPPort()))
    .option("--json", "JSON output (alias for -f json)")
    .action(async (opts: { port: string; json?: boolean }) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        opts.json
          ? "json"
          : (program.opts().format as OutputFormat | undefined),
      );
      const port = parseInt(opts.port, 10);
      const available = await isCDPAvailable(port);
      const profileSource = resolveStatusProfileSource(port, available);
      const daemon = await readStatusDaemonReport(browser);
      if (fmt === "json") {
        const ctx = makeCtx("browser.status", startedAt);
        console.log(
          format(
            {
              port,
              connected: available,
              profile_source: profileSource,
              default_launch: defaultLaunchProfileStatus(),
              daemon,
              raw_cookie_values_returned: false,
            },
            undefined,
            fmt,
            ctx,
          ),
        );
        return;
      }

      if (!available) {
        console.log(
          chalk.yellow(`Chrome CDP not available on port ${String(port)}`),
        );
        console.log(chalk.dim("Run: unicli browser start"));
        printStatusProfileSource(profileSource);
        return;
      }

      console.log(chalk.green(`Chrome CDP connected on port ${String(port)}`));
      printStatusProfileSource(profileSource);
      await printTargetSummary(port);

      printStatusDaemonReport(daemon);
    });

  // unicli browser remote
  browser
    .command("remote")
    .description("Manage remote CDP browser endpoint (Cloudflare, etc.)")
    .option("--status", "Show remote endpoint info and connectivity")
    .option("--connect <endpoint>", "Test connection to a remote CDP endpoint")
    .action(async (opts: { status?: boolean; connect?: string }) => {
      if (opts.connect) {
        // Test connection to a specific endpoint
        console.log(chalk.dim(`Testing connection to: ${opts.connect}`));
        const client = new CDPClient();
        try {
          await client.connect(opts.connect);
          console.log(chalk.green("Connected successfully"));
          // Try to get browser version info
          try {
            const info = (await client.send("Browser.getVersion")) as {
              product?: string;
              userAgent?: string;
            };
            if (info.product) {
              console.log(chalk.dim(`  Browser: ${info.product}`));
            }
            if (info.userAgent) {
              console.log(
                chalk.dim(
                  `  User-Agent: ${info.userAgent.slice(0, 80)}${info.userAgent.length > 80 ? "..." : ""}`,
                ),
              );
            }
          } catch {
            // Non-fatal — version info is optional
          }
          await client.close();
        } catch (err) {
          console.error(
            chalk.red(
              `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          process.exitCode = 1;
        }
        return;
      }

      // Default: --status behavior
      const remote = getRemoteEndpoint();
      if (!remote) {
        console.log(chalk.yellow("No remote CDP endpoint configured"));
        console.log(
          chalk.dim(
            "Set UNICLI_CDP_ENDPOINT to a WebSocket URL (e.g., wss://browser.example.com)",
          ),
        );
        console.log(
          chalk.dim(
            "Optional: set UNICLI_CDP_HEADERS to a JSON string of auth headers",
          ),
        );
        return;
      }

      console.log(chalk.green("Remote CDP endpoint configured"));
      console.log(chalk.dim(`  Endpoint: ${remote.endpoint}`));

      const headerCount = Object.keys(remote.headers).length;
      if (headerCount > 0) {
        console.log(chalk.dim(`  Headers: ${String(headerCount)} configured`));
        for (const key of Object.keys(remote.headers)) {
          console.log(chalk.dim(`    ${key}: ****`));
        }
      } else {
        console.log(chalk.dim("  Headers: none"));
      }

      // Test connectivity
      console.log(chalk.dim("  Testing connection..."));
      const client = new CDPClient();
      try {
        await client.connect(
          remote.endpoint,
          Object.keys(remote.headers).length > 0
            ? { headers: remote.headers }
            : undefined,
        );
        console.log(chalk.green("  Status: connected"));

        try {
          const info = (await client.send("Browser.getVersion")) as {
            product?: string;
          };
          if (info.product) {
            console.log(chalk.dim(`  Browser: ${info.product}`));
          }
        } catch {
          // Non-fatal
        }

        await client.close();
      } catch (err) {
        console.log(
          chalk.red(
            `  Status: unreachable (${err instanceof Error ? err.message : String(err)})`,
          ),
        );
      }
    });

  browser
    .command("doctor")
    .description("Report browser automation reliability and repair status")
    .option("--json", "JSON output (alias for -f json)")
    .option(
      "--repair",
      "Run safe repairs first (starts Uni-CLI automation CDP; never touches the default browser profile)",
    )
    .action(async (opts: { json?: boolean; repair?: boolean }) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        opts.json
          ? "json"
          : (program.opts().format as OutputFormat | undefined),
      );
      const report = await withBrowserOperatorEnv(browser, async () => {
        const repairAttempt = opts.repair
          ? await import("../../browser/doctor.js").then((mod) =>
              mod.repairBrowserDoctor(),
            )
          : undefined;
        return runBrowserDoctor(repairAttempt);
      });
      const ctx = makeCtx("browser.doctor", startedAt);
      ctx.next_actions = report.next_actions.map(toNextAction);
      console.log(
        format(
          report as unknown as Record<string, unknown>,
          undefined,
          fmt,
          ctx,
        ),
      );
      if (report.status !== "ready") process.exitCode = 1;
    });

  browser
    .command("profiles")
    .description("List local Chromium-family browser profiles")
    .option("--json", "JSON output (alias for -f json)")
    .action((opts: { json?: boolean }) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        opts.json
          ? "json"
          : (program.opts().format as OutputFormat | undefined),
      );
      const profiles = detectLocalBrowserProfiles();
      const ctx = makeCtx("browser.profiles", startedAt);
      console.log(
        format(
          {
            source: "local-filesystem",
            raw_cookie_values_returned: false,
            default_launch: defaultLaunchProfileStatus(),
            profiles,
          },
          undefined,
          fmt,
          ctx,
        ),
      );
      console.error(
        chalk.dim(
          `\n  ${String(profiles.length)} local browser profile(s) found. Raw cookie values are not returned.`,
        ),
      );
    });

  // unicli browser cookies <domain>
  browser
    .command("cookies <domain>")
    .description("Extract cookies from Chrome for a domain")
    .option("--port <port>", "CDP port", String(getCDPPort()))
    .option(
      "--profile-id <id>",
      "Use a discovered logged-in browser profile before extracting cookies",
    )
    .option(
      "--save-as <site>",
      "Save with custom site name (default: derived from domain)",
    )
    .action(
      async (
        domain: string,
        opts: { port: string; profileId?: string; saveAs?: string },
      ) => {
        const requestedPort = parseInt(opts.port, 10);
        const localProfile = opts.profileId
          ? resolveLocalBrowserProfile(opts.profileId)
          : null;
        if (opts.profileId && !localProfile) {
          console.error(
            chalk.red(`Browser profile not found: ${opts.profileId}`),
          );
          console.log(chalk.dim("Run: unicli browser profiles --json"));
          process.exitCode = 1;
          return;
        }

        try {
          const { extractCookiesViaCDP, saveCookies } =
            await import("../../engine/cookie-extractor.js");
          const localCookies = localProfile
            ? readCookiesFromLocalProfile(domain, localProfile)
            : null;
          if (localCookies && Object.keys(localCookies).length > 0) {
            printSavedCookies(domain, opts.saveAs, localCookies, saveCookies);
            return;
          }

          const port = await resolveCookieReusePort(
            requestedPort,
            localProfile,
          );
          if (port === null) return;

          const cookies = await extractCookiesViaCDP(domain, port);
          const count = Object.keys(cookies).length;

          if (count === 0) {
            console.log(chalk.yellow(`No cookies found for ${domain}`));
            console.log(
              chalk.dim("Make sure you are logged in to this site in Chrome."),
            );
            return;
          }

          printSavedCookies(domain, opts.saveAs, cookies, saveCookies);
        } catch (err) {
          console.error(
            chalk.red(err instanceof Error ? err.message : String(err)),
          );
          process.exitCode = 1;
        }
      },
    );

  browser
    .command("sessions")
    .description("Show live browser daemon sessions for the selected profile")
    .option("--json", "JSON output (alias for -f json)")
    .action(async (opts: { json?: boolean }) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        opts.json
          ? "json"
          : (program.opts().format as OutputFormat | undefined),
      );
      const ctx = makeCtx("browser.sessions", startedAt);
      try {
        const sessions = await withBrowserOperatorEnv(browser, async () =>
          listSessions(),
        );
        ctx.duration_ms = Date.now() - startedAt;
        if (fmt !== "md") {
          console.log(format({ sessions }, undefined, fmt, ctx));
          return;
        }
        if (sessions.length === 0) {
          console.log(
            chalk.yellow("No browser sessions are currently active."),
          );
          return;
        }

        console.log(chalk.bold("Browser Sessions"));
        for (const session of sessions) {
          const tabs =
            typeof session.tabCount === "number"
              ? ` tabs=${String(session.tabCount)}`
              : "";
          const idle =
            typeof session.idleMsRemaining === "number"
              ? ` idle=${String(Math.ceil(session.idleMsRemaining / 1000))}s`
              : "";
          console.log(
            `  ${session.workspace} -> window ${String(session.windowId)}${tabs}${idle}`,
          );
        }
      } catch (err) {
        ctx.duration_ms = Date.now() - startedAt;
        ctx.error = {
          code: "internal_error",
          message: err instanceof Error ? err.message : String(err),
          suggestion:
            "Run `unicli browser doctor --json` to inspect daemon, extension, and CDP fallback state.",
          retryable: false,
        };
        console.log(format(null, undefined, fmt, ctx));
        process.exitCode = 1;
      }
    });

  browser
    .command("bind")
    .description(
      "Bind the current visible browser tab into the selected workspace",
    )
    .option("--match-domain <domain>", "Require hostname/domain match")
    .option("--match-path-prefix <prefix>", "Require pathname prefix match")
    .action(
      async (opts: { matchDomain?: string; matchPathPrefix?: string }) => {
        await withBrowserOperatorEnv(browser, async () => {
          const workspace = resolveBrowserWorkspace("browser", {
            workspace: (browser.opts() as { workspace?: string }).workspace,
            isolated: (browser.opts() as { isolated?: boolean }).isolated,
            sharedSession: (browser.opts() as { sharedSession?: boolean })
              .sharedSession,
          });
          const result = await bindCurrentTab(workspace, {
            matchDomain: opts.matchDomain,
            matchPathPrefix: opts.matchPathPrefix,
          });
          console.log(
            chalk.green(`Bound workspace ${workspace} to the current tab.`),
          );
          console.log(chalk.dim(JSON.stringify(result, null, 2)));
        });
      },
    );

  registerBrowserAdapterAuthoringSubcommands(browser, program);
  registerBrowserOperatorSubcommands(browser, program, "browser");
}

function toNextAction(command: string): AgentNextAction {
  return {
    command,
    description:
      "Run this when the browser doctor report marks the related surface as incomplete.",
  };
}

function launchOptionsForProfile(
  profile: LocalBrowserProfile,
): ChromeLaunchOptions {
  return {
    ...(profile.browser_path_exists
      ? { browserPath: profile.browser_path }
      : {}),
    seedProfile: profile,
    userDataDir: automationUserDataDirForProfile(profile),
    profileDirectory: profile.profile_dir,
    reuseExisting: false,
  };
}

function printLaunchSource(
  ephemeral: boolean,
  localProfile: LocalBrowserProfile | null,
  explicitProfile: boolean,
): void {
  if (ephemeral) {
    console.log(chalk.yellow("Source: ephemeral empty profile"));
    return;
  }
  const profile = localProfile ?? resolvePreferredLocalBrowserProfile();
  if (!profile) {
    console.log(chalk.yellow("Source: no local profile source"));
    return;
  }
  const targetUserDataDir = explicitProfile
    ? automationUserDataDirForProfile(profile)
    : automationDefaultUserDataDir();
  const seed = inspectAutomationProfileSeed(profile, targetUserDataDir);
  const seedDetail =
    seed.status === "fresh"
      ? `seeded from ${profile.display_name}`
      : `seed status ${seed.status}${seed.reason ? `: ${seed.reason}` : ""}`;
  console.log(chalk.dim(`Source: ${seedDetail}`));
  console.log(chalk.dim(`Automation profile: ${targetUserDataDir}`));
}

type BrowserStatusProfileSource =
  | {
      source: "attach";
      mode: "remote-cdp" | "live-profile-cdp";
      ready: boolean;
      endpoint?: string;
      profile?: ReturnType<typeof describeLocalProfile>;
      port?: number;
      warning?: string;
      raw_cookie_values_returned: false;
    }
  | {
      source: "seeded";
      mode:
        | "seeded-automation-profile"
        | "seeded-automation-profile-not-running";
      ready: boolean;
      preferred_profile: ReturnType<typeof describeLocalProfile>;
      automation_user_data_dir: string;
      seed: ReturnType<typeof inspectAutomationProfileSeed>;
      port?: number;
      warning?: string;
      raw_cookie_values_returned: false;
    }
  | {
      source: "ephemeral";
      mode: "empty-temporary-profile";
      ready: boolean;
      port?: number;
      automation_user_data_dir?: string;
      warning: string;
      raw_cookie_values_returned: false;
    }
  | {
      source: "missing-profile" | "unknown";
      mode: "none" | "unknown-cdp";
      ready: false;
      preferred_profile?: ReturnType<typeof describeLocalProfile>;
      automation_user_data_dir?: string;
      seed?: ReturnType<typeof inspectAutomationProfileSeed>;
      warning: string;
      raw_cookie_values_returned: false;
    };

type BrowserStatusDaemonReport =
  | {
      status: "running";
      port: number;
      extension_connected: boolean;
      sessions_count: number;
      sessions: Array<{
        workspace: string;
        window_id: number;
        tab_count?: number;
        idle_ms_remaining?: number;
      }>;
    }
  | { status: "unavailable"; conflict?: string };

function resolveStatusProfileSource(
  port: number,
  connected: boolean,
): BrowserStatusProfileSource {
  const processTarget = connected ? readProcessDebugTargetForPort(port) : null;
  if (
    processTarget &&
    isEphemeralAutomationUserDataDir(processTarget.user_data_dir)
  ) {
    return {
      source: "ephemeral",
      mode: "empty-temporary-profile",
      ready: true,
      port,
      automation_user_data_dir: processTarget.user_data_dir,
      warning:
        "This CDP port belongs to an explicit ephemeral empty profile; logged-in cookies are intentionally not seeded.",
      raw_cookie_values_returned: false,
    };
  }
  if (isBrowserEphemeralRequested(process.env)) {
    return {
      source: "ephemeral",
      mode: "empty-temporary-profile",
      ready: false,
      warning:
        "UNICLI_BROWSER_EPHEMERAL=1 forces a clean empty profile; logged-in cookies are intentionally not seeded.",
      raw_cookie_values_returned: false,
    };
  }
  const remote = getRemoteEndpoint();
  if (remote) {
    return {
      source: "attach",
      mode: "remote-cdp",
      ready: true,
      endpoint: redactEndpoint(remote.endpoint),
      warning:
        "browser status --port checks local CDP separately; default browser commands attach through UNICLI_CDP_ENDPOINT.",
      raw_cookie_values_returned: false,
    };
  }

  const profiles = detectLocalBrowserProfiles();
  const profile = resolvePreferredLocalBrowserProfile() ?? profiles[0] ?? null;
  const defaultTargetUserDataDir = automationDefaultUserDataDir();
  if (!profile || profiles.length === 0) {
    return {
      source: "missing-profile",
      mode: "none",
      ready: false,
      automation_user_data_dir: defaultTargetUserDataDir,
      warning:
        "No local browser profile source was found; default startup will fail unless --ephemeral is explicit.",
      raw_cookie_values_returned: false,
    };
  }

  const liveProfile = profiles.find((candidate) => {
    return (
      isProcessVerifiedDebugPort(candidate.debug_port) &&
      candidate.debug_port.port === port
    );
  });
  if (connected && liveProfile) {
    return {
      source: "attach",
      mode: "live-profile-cdp",
      ready: true,
      profile: describeLocalProfile(liveProfile),
      port,
      raw_cookie_values_returned: false,
    };
  }

  const liveSeed = statusSeedCandidates(profile, profiles).find((candidate) => {
    const debugPort = readUserDataDirDebugPort(candidate.targetUserDataDir);
    return isProcessVerifiedDebugPort(debugPort) && debugPort.port === port;
  });
  if (connected && liveSeed) {
    const seed = inspectAutomationProfileSeed(
      liveSeed.profile,
      liveSeed.targetUserDataDir,
    );
    return {
      source: "seeded",
      mode: "seeded-automation-profile",
      ready: isRunningSeedIdentityUsable(seed),
      preferred_profile: describeLocalProfile(liveSeed.profile),
      automation_user_data_dir: liveSeed.targetUserDataDir,
      seed,
      port,
      warning:
        seed.status === "fresh"
          ? undefined
          : `Automation profile is running but seed status is ${seed.status}: ${seedWarningReason(seed.reason)}.`,
      raw_cookie_values_returned: false,
    };
  }

  const preferredProfile = describeLocalProfile(profile);
  const seed = inspectAutomationProfileSeed(profile, defaultTargetUserDataDir);
  if (!connected && seed.status === "fresh") {
    return {
      source: "seeded",
      mode: "seeded-automation-profile-not-running",
      ready: false,
      preferred_profile: preferredProfile,
      automation_user_data_dir: defaultTargetUserDataDir,
      seed,
      warning: "No CDP browser is currently reachable on the requested port.",
      raw_cookie_values_returned: false,
    };
  }

  return {
    source: "unknown",
    mode: "unknown-cdp",
    ready: false,
    preferred_profile: preferredProfile,
    automation_user_data_dir: defaultTargetUserDataDir,
    seed,
    warning: connected
      ? "CDP is reachable, but Uni-CLI cannot prove it is the live preferred profile or the seeded automation profile."
      : "No CDP browser is currently reachable on the requested port.",
    raw_cookie_values_returned: false,
  };
}

function statusSeedCandidates(
  preferredProfile: LocalBrowserProfile,
  profiles: LocalBrowserProfile[],
): Array<{ profile: LocalBrowserProfile; targetUserDataDir: string }> {
  const candidates = [
    {
      profile: preferredProfile,
      targetUserDataDir: automationDefaultUserDataDir(),
    },
  ];
  const seen = new Set(
    candidates.map((candidate) => candidate.targetUserDataDir),
  );
  for (const profile of profiles) {
    const targetUserDataDir = automationUserDataDirForProfile(profile);
    if (seen.has(targetUserDataDir)) continue;
    seen.add(targetUserDataDir);
    candidates.push({ profile, targetUserDataDir });
  }
  return candidates;
}

function describeLocalProfile(profile: LocalBrowserProfile): {
  id: string;
  browser_name: string;
  profile_dir: string;
  profile_name: string;
  display_name: string;
  debug_port_state: string;
} {
  return {
    id: profile.id,
    browser_name: profile.browser_name,
    profile_dir: profile.profile_dir,
    profile_name: profile.profile_name,
    display_name: profile.display_name,
    debug_port_state: profile.debug_port.state,
  };
}

function seedWarningReason(reason: string | undefined): string {
  return (reason ?? "manifest is not fresh").replace(/\.+$/, "");
}

async function readStatusDaemonReport(
  browser: Command,
): Promise<BrowserStatusDaemonReport> {
  return withBrowserOperatorEnv(browser, async () => {
    const daemon = await fetchDaemonStatus({ timeout: 1000 });
    if (!daemon) {
      const conflict = await fetchDaemonPortConflict({ timeout: 1000 });
      return conflict
        ? { status: "unavailable", conflict }
        : { status: "unavailable" };
    }
    const sessions = daemon.extensionConnected ? await listSessions() : [];
    return {
      status: "running",
      port: daemon.port,
      extension_connected: daemon.extensionConnected,
      sessions_count: sessions.length,
      sessions: sessions.slice(0, 5).map((session) => ({
        workspace: session.workspace,
        window_id: session.windowId,
        ...(typeof session.tabCount === "number"
          ? { tab_count: session.tabCount }
          : {}),
        ...(typeof session.idleMsRemaining === "number"
          ? { idle_ms_remaining: session.idleMsRemaining }
          : {}),
      })),
    };
  });
}

function printStatusProfileSource(source: BrowserStatusProfileSource): void {
  if (source.source === "attach" && source.mode === "remote-cdp") {
    console.log(chalk.dim(`Source: attach (${source.endpoint})`));
    if (source.warning) console.log(chalk.dim(source.warning));
    return;
  }
  if (source.source === "attach" && source.profile) {
    console.log(
      chalk.dim(`Source: live ${source.profile.display_name} on CDP port`),
    );
    return;
  }
  if (source.source === "seeded") {
    const detail =
      source.seed.status === "fresh"
        ? `seeded from ${source.preferred_profile.display_name}`
        : `seed status ${source.seed.status}${source.seed.reason ? `: ${source.seed.reason}` : ""}`;
    console.log(chalk.dim(`Source: ${detail}`));
    console.log(
      chalk.dim(`Automation profile: ${source.automation_user_data_dir}`),
    );
    if (source.warning) console.log(chalk.yellow(`Warning: ${source.warning}`));
    return;
  }
  console.log(chalk.yellow(`Source: ${source.source} (${source.mode})`));
  console.log(chalk.yellow(`Warning: ${source.warning}`));
}

function printStatusDaemonReport(report: BrowserStatusDaemonReport): void {
  if (report.status === "unavailable") {
    console.log(
      chalk.dim(
        report.conflict
          ? `Daemon: unavailable (${report.conflict})`
          : "Daemon: not running",
      ),
    );
    return;
  }
  console.log(
    chalk.dim(
      `Daemon: port ${String(report.port)}, extension ${
        report.extension_connected ? "connected" : "not connected"
      }`,
    ),
  );
  if (!report.extension_connected || report.sessions.length === 0) return;
  console.log(chalk.dim(`Sessions: ${String(report.sessions_count)}`));
  for (const session of report.sessions) {
    const idle =
      typeof session.idle_ms_remaining === "number"
        ? `, idle ${String(Math.ceil(session.idle_ms_remaining / 1000))}s`
        : "";
    const tabs =
      typeof session.tab_count === "number"
        ? `, tabs ${String(session.tab_count)}`
        : "";
    console.log(
      chalk.dim(
        `  • ${session.workspace} -> window ${String(session.window_id)}${tabs}${idle}`,
      ),
    );
  }
}

function defaultLaunchProfileStatus(): Record<string, unknown> {
  if (isBrowserEphemeralRequested(process.env)) {
    return {
      source: "ephemeral",
      mode: "empty-temporary-profile",
      warning: "UNICLI_BROWSER_EPHEMERAL=1 forces a clean empty profile.",
      raw_cookie_values_returned: false,
    };
  }
  const remote = getRemoteEndpoint();
  if (remote) {
    return {
      source: "attach",
      mode: "remote-cdp",
      endpoint: redactEndpoint(remote.endpoint),
      raw_cookie_values_returned: false,
    };
  }
  const profile = resolvePreferredLocalBrowserProfile();
  const targetUserDataDir = automationDefaultUserDataDir();
  if (!profile) {
    return {
      source: "missing-profile",
      mode: "none",
      automation_user_data_dir: targetUserDataDir,
      warning:
        "Default browser startup requires a local browser profile source or explicit --ephemeral.",
      raw_cookie_values_returned: false,
    };
  }
  const seed = inspectAutomationProfileSeed(profile, targetUserDataDir);
  return {
    source: "seeded",
    mode: isProcessVerifiedDebugPort(profile.debug_port)
      ? "live-profile-or-seeded-profile"
      : "seeded-automation-profile",
    preferred_profile: {
      id: profile.id,
      browser_name: profile.browser_name,
      profile_dir: profile.profile_dir,
      profile_name: profile.profile_name,
      debug_port_state: profile.debug_port.state,
    },
    automation_user_data_dir: targetUserDataDir,
    seed,
    raw_cookie_values_returned: false,
  };
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    if (url.search) url.search = "?...";
    return url.toString();
  } catch {
    return endpoint.replace(/([?&][^=]+)=([^&]+)/g, "$1=...");
  }
}

async function verifyRemoteEndpoint(
  endpoint: string,
  headers: Record<string, string>,
): Promise<void> {
  const client = new CDPClient();
  try {
    await client.connect(
      endpoint,
      Object.keys(headers).length > 0 ? { headers } : undefined,
    );
    await client.send("Browser.getVersion");
  } finally {
    await client.close();
  }
}

async function resolveCookieReusePort(
  requestedPort: number,
  profile: LocalBrowserProfile | null,
): Promise<number | null> {
  if (!profile) {
    if (await isCDPAvailable(requestedPort)) return requestedPort;
    console.error(
      chalk.red(`Chrome CDP not available on port ${String(requestedPort)}`),
    );
    console.log(chalk.dim("Run: unicli browser start"));
    process.exitCode = 1;
    return null;
  }

  const liveProfilePort = await liveRecordedProfilePort(profile);
  if (liveProfilePort !== null) {
    console.error(
      chalk.dim(
        `Using live DevTools port ${String(liveProfilePort)} from ${profile.display_name}.`,
      ),
    );
    return liveProfilePort;
  }

  console.error(
    chalk.red(
      `Direct cookie DB import unavailable for ${profile.display_name}, and Chrome blocks CDP on its default profile.`,
    ),
  );
  console.error(
    chalk.dim(
      "Run `unicli auth import <site> --domain <domain>` or start an automation profile and log in there.",
    ),
  );
  process.exitCode = 1;
  return null;
}

async function liveRecordedProfilePort(
  profile: LocalBrowserProfile,
): Promise<number | null> {
  const debugPort = readUserDataDirDebugPort(profile.user_data_dir);
  if (
    !isProcessVerifiedDebugPort(debugPort) ||
    typeof debugPort.port !== "number"
  ) {
    return null;
  }
  return (await isCDPAvailable(debugPort.port)) ? debugPort.port : null;
}

function readCookiesFromLocalProfile(
  domain: string,
  profile: LocalBrowserProfile,
): Record<string, string> | null {
  const browser = browserIdForLocalProfile(profile);
  if (!browser) return null;
  try {
    const cookies = readCookiesAsRecord({
      browser,
      domain,
      profile: profile.profile_dir,
      userDataDir: profile.user_data_dir,
    });
    if (Object.keys(cookies).length > 0) {
      console.error(
        chalk.dim(
          `Imported raw cookies from ${profile.display_name} (${profile.profile_dir}).`,
        ),
      );
      return cookies;
    }
    return null;
  } catch (err) {
    if (err instanceof ChromiumCookieError) {
      console.error(
        chalk.dim(
          `Direct cookie DB import unavailable for ${profile.display_name} (${err.code}); falling back to CDP.`,
        ),
      );
      return null;
    }
    throw err;
  }
}

function browserIdForLocalProfile(profile: LocalBrowserProfile) {
  return browserCookieIdForLocalProfile(profile);
}

function printSavedCookies(
  domain: string,
  saveAs: string | undefined,
  cookies: Record<string, string>,
  saveCookies: (site: string, cookies: Record<string, string>) => string,
): void {
  const siteName = saveAs ?? domain.replace(/\./g, "-");
  const filePath = saveCookies(siteName, cookies);
  console.log(
    chalk.green(
      `Extracted ${String(Object.keys(cookies).length)} cookies for ${domain}`,
    ),
  );
  console.log(chalk.dim(`Saved to: ${filePath}`));
}

/**
 * Print a summary of available CDP targets.
 */
async function printTargetSummary(port: number): Promise<void> {
  try {
    const targets = await CDPClient.discoverTargets(port);
    const pages = targets.filter((t) => t.type === "page");
    console.log(
      chalk.dim(
        `  Tabs: ${String(targets.length)} target(s), ${String(pages.length)} page(s)`,
      ),
    );
    for (const page of pages.slice(0, 5)) {
      const title = page.title || "(untitled)";
      const url = page.url || "";
      console.log(chalk.dim(`    • ${title} — ${url}`));
    }
    if (pages.length > 5) {
      console.log(chalk.dim(`    ... and ${String(pages.length - 5)} more`));
    }
  } catch {
    // Non-fatal — we already confirmed CDP is available
  }
}
