/**
 * Browser CLI subcommands — Chrome launcher and CDP connection management.
 *
 * Commands:
 *   browser start          — Start or connect to Chrome with CDP enabled
 *   browser status         — Check Chrome CDP connection status
 *   browser cookies <domain> — Extract cookies from Chrome for a domain
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  findChrome,
  isCDPAvailable,
  launchChrome,
  getCDPPort,
} from "../browser/launcher.js";
import { CDPClient, getRemoteEndpoint } from "../browser/cdp-client.js";
import {
  bindCurrentTab,
  fetchDaemonStatus,
  listSessions,
} from "../browser/daemon-client.js";
import {
  applyBrowserOperatorRootOptions,
  registerBrowserOperatorSubcommands,
  withBrowserOperatorEnv,
} from "./browser-operator.js";
import { registerBrowserAdapterAuthoringSubcommands } from "./browser-adapter-authoring.js";
import { resolveBrowserWorkspace } from "../browser/workspace.js";

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
    .option("--headless", "Launch in headless mode (for CI)")
    .action(
      async (opts: { port: string; profile?: boolean; headless?: boolean }) => {
        const port = parseInt(opts.port, 10);

        // Check if already available
        if (await isCDPAvailable(port)) {
          console.log(
            chalk.green(`Chrome CDP already available on port ${String(port)}`),
          );
          await printTargetSummary(port);
          return;
        }

        // Find Chrome
        const chromePath = findChrome();
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
        console.log(chalk.dim(`Launching with CDP on port ${String(port)}...`));

        try {
          const actualPort = await launchChrome(port, {
            profile: opts.profile,
            headless: opts.headless,
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
          console.log(chalk.dim("Daemon: not running"));
          return;
        }
        console.log(
          chalk.dim(
            `Daemon: port ${String(daemon.port)}, extension ${
              daemon.extensionConnected ? "connected" : "not connected"
            }`,
          ),
        );
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

  // unicli browser cookies <domain>
  browser
    .command("cookies <domain>")
    .description("Extract cookies from Chrome for a domain")
    .option("--port <port>", "CDP port", String(getCDPPort()))
    .option(
      "--save-as <site>",
      "Save with custom site name (default: derived from domain)",
    )
    .action(async (domain: string, opts: { port: string; saveAs?: string }) => {
      const port = parseInt(opts.port, 10);

      if (!(await isCDPAvailable(port))) {
        console.error(
          chalk.red(`Chrome CDP not available on port ${String(port)}`),
        );
        console.log(chalk.dim("Run: unicli browser start"));
        process.exitCode = 1;
        return;
      }

      try {
        const { extractCookiesViaCDP, saveCookies } =
          await import("../engine/cookie-extractor.js");
        const cookies = await extractCookiesViaCDP(domain, port);
        const count = Object.keys(cookies).length;

        if (count === 0) {
          console.log(chalk.yellow(`No cookies found for ${domain}`));
          console.log(
            chalk.dim("Make sure you are logged in to this site in Chrome."),
          );
          return;
        }

        const siteName = opts.saveAs ?? domain.replace(/\./g, "-");
        const filePath = saveCookies(siteName, cookies);
        console.log(
          chalk.green(`Extracted ${String(count)} cookies for ${domain}`),
        );
        console.log(chalk.dim(`Saved to: ${filePath}`));
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
      }
    });

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
