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
import type { OutputFormat } from "../types.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage authentication cookies for site adapters");

  // --- auth setup <site> ---
  auth
    .command("setup <site>")
    .description("Show required cookies and setup instructions for a site")
    .action((site: string) => {
      const startedAt = Date.now();
      const ctx = makeCtx("auth.setup", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const adapter = getAllAdapters().find((a) => a.name === site);
      if (!adapter) {
        ctx.error = {
          code: "invalid_input",
          message: `Unknown site: ${site}`,
          suggestion: "Run `unicli list` to see available sites.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.USAGE_ERROR);
      }

      const dir = getCookieDir();
      const filePath = join(dir, `${site}.json`);
      const required = adapter.authCookies ?? [];
      const template: Record<string, string> = {};
      for (const key of required.length > 0 ? required : ["COOKIE_NAME"]) {
        template[key] = "PASTE_VALUE_HERE";
      }

      const data = {
        site,
        cookie_dir: dir,
        cookie_file: filePath,
        strategy: adapter.strategy ?? "public",
        required_cookies: required,
        template,
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      // Human-oriented summary → stderr (Scene-6 pattern)
      console.error(
        chalk.dim(`\n  Template keys: ${Object.keys(template).join(", ")}`),
      );
      console.error(
        chalk.dim(
          `  Save JSON to ${filePath}, then: unicli auth check ${site}`,
        ),
      );
    });

  // --- auth check <site> ---
  auth
    .command("check <site>")
    .description("Validate cookie file for a site")
    .action((site: string) => {
      const startedAt = Date.now();
      const ctx = makeCtx("auth.check", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const adapter = getAllAdapters().find((a) => a.name === site);
      if (!adapter) {
        ctx.error = {
          code: "invalid_input",
          message: `Unknown site: ${site}`,
          suggestion: "Run `unicli list` to see available sites.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.USAGE_ERROR);
      }

      const cookies = loadCookies(site);
      if (!cookies) {
        const filePath = join(getCookieDir(), `${site}.json`);
        ctx.error = {
          code: "auth_required",
          message: `No cookie file found: ${filePath}`,
          suggestion: `Run: unicli auth setup ${site}`,
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.AUTH_REQUIRED);
      }

      const keys = Object.keys(cookies);
      const required = adapter.authCookies ?? [];
      const { valid, missing } =
        required.length > 0
          ? validateCookies(site, required)
          : { valid: true, missing: [] as string[] };

      if (!valid) {
        ctx.error = {
          code: "auth_required",
          message: `Missing required cookies: ${missing.join(", ")}`,
          suggestion: `Run: unicli auth setup ${site}`,
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.AUTH_REQUIRED);
      }

      const data = {
        site,
        cookie_count: keys.length,
        cookies: keys,
        required_cookies: required,
        valid: true,
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(data, undefined, fmt, ctx));

      console.error(
        chalk.green(`  ✓ ${site}: ${keys.length} cookie(s) present`),
      );
    });

  // --- auth list ---
  auth
    .command("list")
    .description("List all sites with configured cookies")
    .action(() => {
      const startedAt = Date.now();
      const ctx = makeCtx("auth.list", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const dir = getCookieDir();

      let files: string[] = [];
      if (existsSync(dir)) {
        try {
          files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        } catch {
          files = [];
        }
      }

      const rows = files.map((file) => {
        const site = basename(file, ".json");
        const cookies = loadCookies(site);
        return {
          site,
          cookie_count: cookies ? Object.keys(cookies).length : 0,
        };
      });

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(rows, ["site", "cookie_count"], fmt, ctx));

      if (rows.length === 0) {
        console.error(chalk.dim(`\n  No cookies configured in ${dir}`));
        console.error(
          chalk.dim("  Run: unicli auth setup <site> to configure."),
        );
      } else {
        console.error(
          chalk.dim(`\n  ${rows.length} site(s) configured in ${dir}`),
        );
      }
    });
}
