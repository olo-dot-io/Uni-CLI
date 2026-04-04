/**
 * Browser CLI subcommands — Chrome launcher and CDP connection management.
 *
 * Commands:
 *   browser start   — Start or connect to Chrome with CDP enabled
 *   browser status  — Check Chrome CDP connection status
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  findChrome,
  isCDPAvailable,
  launchChrome,
  getCDPPort,
} from "../browser/launcher.js";
import { CDPClient } from "../browser/cdp-client.js";

export function registerBrowserCommands(program: Command): void {
  const browser = program
    .command("browser")
    .description("Manage Chrome browser connection for browser adapters");

  // unicli browser start
  browser
    .command("start")
    .description("Start or connect to Chrome with CDP enabled")
    .option("--port <port>", "CDP port", String(getCDPPort()))
    .action(async (opts: { port: string }) => {
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
        const actualPort = await launchChrome(port);
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
    });

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
