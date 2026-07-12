/**
 * @owner       src::commands::auth
 * @does        Reports auth requirements, explicitly imports cookies, validates storage, and audits browser reachability.
 * @needs       adapter registry, Chromium cookie readers, owner-only cookie storage, v2 formatter
 * @feeds       `unicli auth setup|import|check|list|audit` and `unicli doctor cookies`
 * @breaks      Invalid targets, browser/keychain failures, corrupt storage, and missing cookies emit semantic errors.
 * @invariants  Only `auth import` persists browser cookies; values never appear in output or logs.
 * @side-effects Explicit import writes plaintext JSON with owner-only permissions; audit/check read local state.
 * @perf        Import stops on the first browser hit; audit is bounded by --limit.
 * @concurrency Commands are single-process and storage replacement is atomic.
 * @test        tests/unit/commands/auth.test.ts, tests/unit/cookie-storage.test.ts
 * @stability   public
 * @since       2026-04-04
 */

import { Command } from "commander";
import chalk from "chalk";
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { commandStrategy, getAllAdapters } from "../registry.js";
import { getCookieDir } from "../engine/cookies.js";
import {
  BROWSER_IDS,
  ChromiumCookieError,
  detectInstalledBrowsers,
  listProfiles,
  readCookiesAsRecord,
  resolveCookieDb,
  type BrowserId,
} from "../engine/chromium-cookies.js";
import {
  readDiskCookies,
  saveCookies as saveCookiesToDisk,
} from "../engine/cookie-storage.js";
import { execFileSync } from "node:child_process";
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
      const commandAuthStrategy = Object.values(adapter.commands)
        .map((cmd) => commandStrategy(adapter, cmd))
        .find((strategy) => strategy && strategy !== "public");
      const siteStrategy =
        adapter.strategy && adapter.strategy !== "public"
          ? adapter.strategy
          : (commandAuthStrategy ?? adapter.strategy ?? "public");
      const template: Record<string, string> = {};
      for (const key of required.length > 0 ? required : ["COOKIE_NAME"]) {
        template[key] = "PASTE_VALUE_HERE";
      }

      const data = {
        site,
        cookie_dir: dir,
        cookie_file: filePath,
        persistence: "explicit",
        storage_format: "plaintext-json",
        directory_mode: process.platform === "win32" ? null : "0700",
        file_mode: process.platform === "win32" ? null : "0600",
        strategy: siteStrategy,
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
        chalk.dim(`  Explicit local persistence: unicli auth import ${site}`),
      );
      console.error(
        chalk.dim(
          process.platform === "win32"
            ? `  Storage is plaintext JSON at ${filePath}; protection follows that path's Windows ACL.`
            : `  Storage is plaintext JSON at ${filePath} (directory 0700, file 0600).`,
        ),
      );
    });

  // --- auth import <site> ---
  auth
    .command("import <site>")
    .description(
      "Explicitly import and persist cookies from a local browser (Chrome/Arc/Dia/Brave/Edge/Atlas)",
    )
    .option(
      "-b, --browser <id>",
      `Browser to read from (${BROWSER_IDS.join("|")}); default: auto-detect`,
    )
    .option("-p, --profile <name>", "Browser profile (default: most-recent)")
    .option(
      "-d, --domain <domain>",
      "Cookie domain (default: derived from site name)",
    )
    .action(
      (
        site: string,
        opts: { browser?: string; profile?: string; domain?: string },
      ) => {
        const startedAt = Date.now();
        const ctx = makeCtx("auth.import", startedAt);
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );

        if (!/^[a-zA-Z0-9._-]+$/.test(site)) {
          ctx.error = {
            code: "invalid_input",
            message: `Invalid site name: "${site}"`,
            suggestion:
              "Site names must contain only letters, digits, dot, dash, or underscore.",
            retryable: false,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }

        let domain = opts.domain ?? site.replace(/_/g, ".");
        if (!domain.includes(".")) domain = `${domain}.com`;
        if (!/^[a-zA-Z0-9.-]+$/.test(domain)) {
          ctx.error = {
            code: "invalid_input",
            message: `Invalid domain: "${domain}"`,
            suggestion: "Pass --domain example.com.",
            retryable: false,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }

        const browsers: BrowserId[] = opts.browser
          ? [opts.browser as BrowserId]
          : detectInstalledBrowsers();

        if (browsers.length === 0) {
          ctx.error = {
            code: "auth_required",
            message: "No supported Chromium browser found locally",
            suggestion: `Install one of: ${BROWSER_IDS.join(", ")}.`,
            retryable: false,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.AUTH_REQUIRED);
        }

        if (
          opts.browser &&
          !(BROWSER_IDS as readonly string[]).includes(opts.browser)
        ) {
          ctx.error = {
            code: "invalid_input",
            message: `Unknown browser: "${opts.browser}"`,
            suggestion: `Choose one of: ${BROWSER_IDS.join(", ")}.`,
            retryable: false,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }

        let lastError: ChromiumCookieError | undefined;
        for (const browser of browsers) {
          try {
            const cookies = readCookiesAsRecord({
              browser,
              domain,
              profile: opts.profile,
            });
            if (Object.keys(cookies).length === 0) {
              lastError = new ChromiumCookieError(
                "no_profile",
                `${browser}: no cookies for domain ${domain}`,
                `Sign into https://${domain} in ${browser}, then re-run.`,
              );
              continue;
            }
            const filePath = saveCookiesToDisk(site, cookies);

            const data = {
              site,
              browser,
              domain,
              profile: opts.profile ?? "auto",
              cookie_count: Object.keys(cookies).length,
              cookies: Object.keys(cookies),
              file: filePath,
              storage_format: "plaintext-json",
              directory_mode: process.platform === "win32" ? null : "0700",
              file_mode: process.platform === "win32" ? null : "0600",
            };
            ctx.duration_ms = Date.now() - startedAt;
            console.log(format(data, undefined, fmt, ctx));
            console.error(
              chalk.green(
                `  ✓ ${browser} → ${site}: ${Object.keys(cookies).length} cookie(s) saved to ${filePath}`,
              ),
            );
            return;
          } catch (err) {
            if (err instanceof ChromiumCookieError) {
              lastError = err;
              continue;
            }
            ctx.error = {
              code: "permission_denied",
              message: `Could not securely persist cookies for ${site}: ${err instanceof Error ? err.message : String(err)}`,
              suggestion: `Check ownership and permissions for ${getCookieDir()}, then rerun the explicit import.`,
              retryable: false,
            };
            console.error(format(null, undefined, fmt, ctx));
            process.exit(ExitCode.CONFIG_ERROR);
          }
        }

        ctx.error = {
          code: "auth_required",
          message:
            lastError?.message ??
            `Could not read cookies for ${domain} from any installed browser.`,
          suggestion:
            lastError?.suggestion ??
            `Try: unicli auth import ${site} --browser <other> --profile <name>`,
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.AUTH_REQUIRED);
      },
    );

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

      const stored = readDiskCookies(site);
      if (stored.kind === "absent") {
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
      if (stored.kind === "corrupt") {
        ctx.error = {
          code: "invalid_input",
          message: `Cookie storage is not safe and readable: ${stored.detail}`,
          suggestion: `Re-import with: unicli auth import ${site}`,
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.CONFIG_ERROR);
      }

      const cookies = stored.cookies;
      const keys = Object.keys(cookies);
      const required = adapter.authCookies ?? [];
      const missing = required.filter((key) => !(key in cookies));
      const valid = missing.length === 0;

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
        } catch (error) {
          ctx.error = {
            code: "permission_denied",
            message: `Cannot enumerate cookie storage ${dir}: ${error instanceof Error ? error.message : String(error)}`,
            suggestion: "Restore directory ownership and owner-only access.",
            retryable: false,
          };
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.CONFIG_ERROR);
        }
      }

      const rows = files.map((file) => {
        const site = basename(file, ".json");
        const stored = readDiskCookies(site);
        return {
          site,
          cookie_count:
            stored.kind === "ok" ? Object.keys(stored.cookies).length : 0,
          status: stored.kind === "ok" ? "ok" : stored.kind,
        };
      });

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format(rows, ["site", "cookie_count", "status"], fmt, ctx));

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

  // --- auth audit ---
  auth
    .command("audit")
    .description(
      "Walk every cookie/header adapter and report cookie reachability per browser",
    )
    .option(
      "-b, --browser <id>",
      "Restrict to a single browser (default: all detected)",
    )
    .option("--limit <n>", "Cap audited adapters", (v) => parseInt(v, 10))
    .action((opts: { browser?: string; limit?: number }) => {
      const startedAt = Date.now();
      const ctx = makeCtx("auth.audit", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const browsers: BrowserId[] = opts.browser
        ? [opts.browser as BrowserId]
        : detectInstalledBrowsers();

      const adapters = getAllAdapters().filter((a) => {
        const strategy =
          a.strategy ??
          Object.values(a.commands)
            .map((cmd) => commandStrategy(a, cmd))
            .find((s) => s);
        return strategy === "cookie" || strategy === "header";
      });

      const subject = opts.limit ? adapters.slice(0, opts.limit) : adapters;
      const rows = subject.map((a) => {
        const declared =
          a.domain ?? Object.values(a.commands).find((c) => c.domain)?.domain;
        const result: {
          site: string;
          declared_domain: string | null;
          inferred_domain: string;
          status: "ok" | "no-domain" | "no-cookies" | "blocked";
          cookies_per_browser: Record<string, number>;
          errors: string[];
          suggestion?: string;
        } = {
          site: a.name,
          declared_domain: declared ?? null,
          inferred_domain: declared ?? deriveDomain(a.name),
          status: "no-cookies",
          cookies_per_browser: {},
          errors: [],
        };

        if (!declared) {
          result.status = "no-domain";
          result.suggestion = `Add 'domain: <example.com>' to src/adapters/${a.name}/*.yaml — site-name guessing is unreliable.`;
        }

        let totalCookies = 0;
        for (const browser of browsers) {
          try {
            const record = readCookiesAsRecord({
              browser,
              domain: result.inferred_domain,
            });
            result.cookies_per_browser[browser] = Object.keys(record).length;
            totalCookies += Object.keys(record).length;
          } catch (err) {
            const e = err as ChromiumCookieError;
            result.cookies_per_browser[browser] = 0;
            if (e.code === "encryption_unsupported") {
              result.status = "blocked";
              result.errors.push(`${browser}: ${e.message}`);
            } else if (
              e.code !== "browser_not_installed" &&
              e.code !== "no_profile"
            ) {
              result.errors.push(`${browser}: ${e.code}`);
            }
          }
        }
        if (totalCookies > 0 && result.status !== "no-domain") {
          result.status = "ok";
        }
        return result;
      });

      const summary = {
        platform: process.platform,
        browsers_checked: browsers,
        adapters_audited: rows.length,
        ok: rows.filter((r) => r.status === "ok").length,
        no_cookies: rows.filter((r) => r.status === "no-cookies").length,
        no_domain: rows.filter((r) => r.status === "no-domain").length,
        blocked: rows.filter((r) => r.status === "blocked").length,
      };

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format({ summary, adapters: rows }, undefined, fmt, ctx));
      console.error(
        chalk.dim(
          `\n  ${summary.ok}/${summary.adapters_audited} ok · ` +
            `${summary.no_domain} missing-domain · ` +
            `${summary.no_cookies} no-cookies · ` +
            `${summary.blocked} blocked`,
        ),
      );
    });
}

function deriveDomain(site: string): string {
  let d = site.replace(/_/g, ".");
  if (!d.includes(".")) d = `${d}.com`;
  return d;
}

/* -------------------------------------------------------------------------- */
/*  doctor cookies — installable as a `unicli doctor` subcommand              */
/* -------------------------------------------------------------------------- */

export function registerDoctorCookies(parent: Command): void {
  parent
    .command("cookies")
    .description("Diagnose direct browser cookie reads on this machine")
    .action(() => {
      const platform = process.platform;
      const sqliteOk = (() => {
        try {
          const out = execFileSync(
            process.env.UNICLI_SQLITE_BIN ?? "sqlite3",
            ["-version"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          );
          return out.trim();
        } catch {
          return null;
        }
      })();

      const browsers = BROWSER_IDS.map((b) => {
        const profiles = listProfiles(b);
        let resolveError: string | null = null;
        if (profiles.length > 0) {
          try {
            resolveCookieDb(b);
          } catch (err) {
            resolveError = (err as ChromiumCookieError).code;
          }
        }
        return {
          browser: b,
          installed: profiles.length > 0,
          profiles,
          resolve_error: resolveError,
        };
      });

      const data = {
        platform,
        sqlite: sqliteOk,
        browsers,
        notes: [
          platform === "win32"
            ? "Windows: Chrome 127+ uses App-Bound Encryption (v20). External processes are blocked. Use CDP via `unicli browser start`."
            : null,
          sqliteOk
            ? null
            : "sqlite3 binary not found on PATH; install with `apt install sqlite3` / `brew install sqlite` / set UNICLI_SQLITE_BIN.",
          process.platform === "linux"
            ? "Linux: secret-tool is recommended; falls back to the literal 'peanuts' v10 password if no keyring is configured."
            : null,
        ].filter((n): n is string => n !== null),
      };

      console.log(JSON.stringify(data, null, 2));
    });
}
