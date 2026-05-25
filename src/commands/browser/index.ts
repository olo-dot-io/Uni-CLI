/**
 * @owner   src/commands/browser/index.ts
 * @does    Register browser root commands for Chrome lifecycle, CDP status, doctor reports, local profiles, cookies, sessions, actions, and adapter authoring.
 * @needs   commander, chalk, src/browser launcher/CDP/daemon/workspace/local-profiles/doctor, ./actions, ./adapter, output formatter, src/engine cookie-extractor/chromium-cookies
 * @feeds   src/cli.ts, tests/unit/commands/browser.test.ts
 * @breaks  Chrome, CDP, daemon, and cookie failures propagate through command errors and stderr. No fallback.
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
  automationUserDataDirForProfile,
  detectLocalBrowserProfiles,
  resolveLocalBrowserProfile,
  type LocalBrowserProfile,
} from "../../browser/local-profiles.js";
import { runBrowserDoctor } from "../../browser/doctor.js";
import {
  ChromiumCookieError,
  readCookiesAsRecord,
  type BrowserId,
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
    .action(
      async (opts: {
        port: string;
        profile?: boolean;
        profileId?: string;
        headless?: boolean;
      }) => {
        const port = parseInt(opts.port, 10);
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

        const liveProfilePort = localProfile
          ? await liveRecordedProfilePort(localProfile)
          : null;
        if (liveProfilePort !== null) {
          console.log(
            chalk.green(
              `Chrome CDP already available for ${localProfile?.display_name ?? "selected profile"} on port ${String(liveProfilePort)}`,
            ),
          );
          await printTargetSummary(liveProfilePort);
          return;
        }

        // Check if already available
        if (!localProfile && (await isCDPAvailable(port))) {
          console.log(
            chalk.green(`Chrome CDP already available on port ${String(port)}`),
          );
          await printTargetSummary(port);
          return;
        }

        // Find Chrome
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
        if (localProfile) {
          console.log(
            chalk.dim(
              `Using profile: ${localProfile.display_name} (${localProfile.id})`,
            ),
          );
        }
        console.log(chalk.dim(`Launching with CDP on port ${String(port)}...`));

        try {
          const launchPort = localProfile
            ? await findAvailableProfileLaunchPort(port, localProfile)
            : port;
          const browserRootOpts = browser.opts() as { focus?: boolean };
          const actualPort = await launchChrome(launchPort, {
            profile: opts.profile,
            headless: opts.headless,
            ...(localProfile ? launchOptionsForProfile(localProfile) : {}),
            ...(browserRootOpts.focus === true ? { background: false } : {}),
          });
          console.log(
            chalk.green(`Chrome CDP ready on port ${String(actualPort)}`),
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
    .action(async (opts: { port: string }) => {
      const port = parseInt(opts.port, 10);

      const available = await isCDPAvailable(port);
      if (!available) {
        console.log(
          chalk.yellow(`Chrome CDP not available on port ${String(port)}`),
        );
        console.log(chalk.dim("Run: unicli browser start"));
        return;
      }

      console.log(chalk.green(`Chrome CDP connected on port ${String(port)}`));
      await printTargetSummary(port);

      await withBrowserOperatorEnv(browser, async () => {
        const daemon = await fetchDaemonStatus({ timeout: 1000 });
        if (!daemon) {
          const conflict = await fetchDaemonPortConflict({ timeout: 1000 });
          console.log(
            chalk.dim(
              conflict
                ? `Daemon: unavailable (${conflict})`
                : "Daemon: not running",
            ),
          );
          return;
        }
        console.log(
          chalk.dim(
            `Daemon: port ${String(daemon.port)}, extension ${
              daemon.extensionConnected ? "connected" : "not connected"
            }`,
          ),
        );
        if (!daemon.extensionConnected) return;
        const sessions = await listSessions();
        if (sessions.length > 0) {
          console.log(chalk.dim(`Sessions: ${String(sessions.length)}`));
          for (const session of sessions.slice(0, 5)) {
            const idle =
              typeof session.idleMsRemaining === "number"
                ? `, idle ${String(Math.ceil(session.idleMsRemaining / 1000))}s`
                : "";
            const tabs =
              typeof session.tabCount === "number"
                ? `, tabs ${String(session.tabCount)}`
                : "";
            console.log(
              chalk.dim(
                `  • ${session.workspace} -> window ${String(session.windowId)}${tabs}${idle}`,
              ),
            );
          }
        }
      });
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
    .action(async () => {
      await withBrowserOperatorEnv(browser, async () => {
        const sessions = await listSessions();
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
      });
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
    userDataDir: automationUserDataDirForProfile(profile),
    reuseExisting: false,
  };
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
  if (
    profile.debug_port.state !== "recorded" ||
    typeof profile.debug_port.port !== "number"
  ) {
    return null;
  }
  return (await isCDPAvailable(profile.debug_port.port))
    ? profile.debug_port.port
    : null;
}

async function findAvailableProfileLaunchPort(
  requestedPort: number,
  profile: LocalBrowserProfile,
): Promise<number> {
  const launchPort = await findAvailableCDPPort(requestedPort);
  if (launchPort !== requestedPort) {
    console.error(
      chalk.dim(
        `Port ${String(requestedPort)} already has a local listener; launching ${profile.display_name} on ${String(launchPort)} instead.`,
      ),
    );
  }
  return launchPort;
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

function browserIdForLocalProfile(
  profile: LocalBrowserProfile,
): BrowserId | null {
  switch (profile.browser_name) {
    case "Google Chrome":
      return "chrome";
    case "Brave":
      return "brave";
    case "Microsoft Edge":
      return "edge";
    case "Arc":
      return "arc";
    case "Dia":
      return "dia";
    default:
      return null;
  }
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
