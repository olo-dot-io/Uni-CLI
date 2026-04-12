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

export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command("browser")
    .description("Manage Chrome browser connection for browser adapters");

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
