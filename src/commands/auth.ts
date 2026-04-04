/**
 * Auth CLI subcommands — cookie management for authenticated adapters.
 *
 * Commands:
 *   auth setup <site>  — Show required cookies and setup instructions
 *   auth check <site>  — Validate cookie file for a site
 *   auth list           — List all sites with configured cookies
 */

import { Command } from "commander";
import chalk from "chalk";
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { getAllAdapters } from "../registry.js";
import {
  loadCookies,
  validateCookies,
  getCookieDir,
} from "../engine/cookies.js";
import { ExitCode } from "../types.js";

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage authentication cookies for site adapters");

  // --- auth setup <site> ---
  auth
    .command("setup <site>")
    .description("Show required cookies and setup instructions for a site")
    .action((site: string) => {
      const adapter = getAllAdapters().find((a) => a.name === site);
      if (!adapter) {
        console.error(chalk.red(`Unknown site: ${site}`));
        process.exit(ExitCode.USAGE_ERROR);
      }

      const dir = getCookieDir();
      const filePath = join(dir, `${site}.json`);
      const required = adapter.authCookies ?? [];

      console.log(chalk.bold(`Auth setup: ${site}`));
      console.log();
      console.log(`  Cookie dir:  ${chalk.cyan(dir)}`);
      console.log(`  Cookie file: ${chalk.cyan(filePath)}`);
      console.log(
        `  Strategy:    ${chalk.yellow(adapter.strategy ?? "public")}`,
      );
      console.log();

      if (required.length > 0) {
        console.log(chalk.bold("Required cookies:"));
        for (const key of required) {
          console.log(`  ${chalk.green("•")} ${key}`);
        }
      } else {
        console.log(
          chalk.dim("No required cookies declared in adapter manifest."),
        );
      }

      console.log();
      console.log(chalk.bold("Template:"));

      const template: Record<string, string> = {};
      for (const key of required.length > 0 ? required : ["COOKIE_NAME"]) {
        template[key] = "PASTE_VALUE_HERE";
      }
      console.log(chalk.dim(JSON.stringify(template, null, 2)));

      console.log();
      console.log(
        chalk.dim("Save the above JSON to the cookie file, then run:"),
      );
      console.log(chalk.dim(`  unicli auth check ${site}`));
    });

  // --- auth check <site> ---
  auth
    .command("check <site>")
    .description("Validate cookie file for a site")
    .action((site: string) => {
      const adapter = getAllAdapters().find((a) => a.name === site);
      if (!adapter) {
        console.error(chalk.red(`Unknown site: ${site}`));
        process.exit(ExitCode.USAGE_ERROR);
      }

      const cookies = loadCookies(site);
      if (!cookies) {
        const filePath = join(getCookieDir(), `${site}.json`);
        console.error(chalk.red(`No cookie file found: ${filePath}`));
        console.error(chalk.dim(`Run: unicli auth setup ${site}`));
        process.exit(ExitCode.AUTH_REQUIRED);
      }

      const keys = Object.keys(cookies);
      console.log(chalk.bold(`Auth check: ${site}`));
      console.log(
        `  Found ${chalk.green(keys.length)} cookie(s): ${keys.join(", ")}`,
      );

      const required = adapter.authCookies ?? [];
      if (required.length > 0) {
        const { valid, missing } = validateCookies(site, required);
        if (valid) {
          console.log(chalk.green("  ✓ All required cookies present"));
        } else {
          console.log(chalk.red(`  ✗ Missing: ${missing.join(", ")}`));
          process.exit(ExitCode.AUTH_REQUIRED);
        }
      } else {
        console.log(
          chalk.dim(
            "  No required cookies declared — file exists, looks good.",
          ),
        );
      }
    });

  // --- auth list ---
  auth
    .command("list")
    .description("List all sites with configured cookies")
    .action(() => {
      const dir = getCookieDir();

      if (!existsSync(dir)) {
        console.log(chalk.dim(`Cookie dir not found: ${dir}`));
        console.log(chalk.dim("No cookies configured yet."));
        return;
      }

      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        console.log(chalk.dim("Could not read cookie directory."));
        return;
      }

      if (files.length === 0) {
        console.log(chalk.dim("No cookie files found."));
        return;
      }

      console.log(chalk.bold("Configured cookies:"));
      for (const file of files) {
        const site = basename(file, ".json");
        const cookies = loadCookies(site);
        const count = cookies ? Object.keys(cookies).length : 0;
        console.log(`  ${chalk.cyan(site)} — ${count} key(s)`);
      }
    });
}
