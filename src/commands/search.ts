/**
 * Search command — intent search across all adapters.
 *
 * Usage:
 *   unicli search "twitter trending"  → finds twitter/trending
 *   unicli search "download video"     → finds bilibili/download, youtube/download, ...
 *   unicli search "stock price"       → finds xueqiu/stock, eastmoney/stock, ...
 *   unicli search --category finance   → lists all finance commands
 */

import { Command, Option } from "commander";
import chalk from "chalk";
import { search } from "../discovery/search.js";
import { format, detectFormat } from "../output/formatter.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { emptySearchResultError } from "../output/error-map.js";
import type { AgentContext } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";
import type {
  ExecutionOperator,
  OperationEffect,
  TargetSurface,
} from "../types.js";
import type { CapabilityRequirements } from "../discovery/feasibility.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search [query...]")
    .description(
      "Search commands by intent. Example: unicli search twitter trending",
    )
    .option("-n, --limit <n>", "max results", "8")
    .option("--category <cat>", "filter by category")
    .addOption(
      new Option(
        "--operator <operator>",
        "require one execution operator",
      ).choices([
        "structured-api",
        "browser-protocol",
        "native-cli",
        "browser-semantic",
        "desktop-accessibility",
        "visual-observation",
        "visual-coordinate",
        "local-runtime",
      ]),
    )
    .addOption(
      new Option("--surface <surface>", "require one target surface").choices([
        "web",
        "desktop",
        "system",
        "mobile",
      ]),
    )
    .addOption(
      new Option("--effect <effect>", "require one operation effect").choices([
        "read",
        "download_file",
        "send_message",
        "publish_content",
        "account_state",
        "remote_transform",
        "remote_resource",
        "service_state",
        "local_app",
        "local_file",
        "destructive",
        "unknown_write",
      ]),
    )
    .addOption(
      new Option("--platform <platform>", "require a compatible host platform")
        .choices(["darwin", "win32", "linux"])
        .default(process.platform),
    )
    .action(
      (
        queryParts: string[],
        opts: {
          limit: string;
          category?: string;
          operator?: ExecutionOperator;
          surface?: TargetSurface;
          effect?: OperationEffect;
          platform?: NodeJS.Platform;
        },
      ) => {
        const searchStarted = Date.now();
        const query = queryParts.join(" ");
        const limit = parseInt(opts.limit, 10) || 8;

        if (!query && !opts.category) {
          console.error(
            chalk.red(
              "Usage: unicli search <query>  or  unicli search --category <cat>",
            ),
          );
          process.exitCode = 2;
          return;
        }

        const requirements: CapabilityRequirements = {
          ...(opts.operator ? { operator: opts.operator } : {}),
          ...(opts.surface ? { target_surface: opts.surface } : {}),
          ...(opts.effect ? { effect: opts.effect } : {}),
          ...(opts.platform ? { platform: opts.platform } : {}),
          ...(opts.operator
            ? {
                allow_coordinate_actuation:
                  opts.operator === "visual-coordinate",
              }
            : {}),
        };
        const results = search(query, limit, {
          category: opts.category,
          requirements,
        });

        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );

        if (results.length === 0) {
          const queryLabel = [opts.category, query].filter(Boolean).join(" ");
          printErrorEnvelope({
            fmt,
            exitCode: 66, // EX_EMPTY
            ctx: {
              command: "core.search",
              duration_ms: Date.now() - searchStarted,
              surface: "web",
              error: emptySearchResultError(
                queryLabel,
                query.replace(/"/g, "").trim(),
              ),
            },
          });
          return;
        }

        const rows = results.map((r) => ({
          command: `${r.site} ${r.command}`,
          description: r.description || `${r.command} for ${r.site}`,
          score: r.score,
          category: r.category,
          ...(r.feasibility
            ? {
                operator: r.feasibility.operator,
                effect: r.feasibility.effect,
                target_surface: r.feasibility.target_surface,
                target_scope: r.feasibility.target_scope,
                evidence_scope: "catalog_contract",
                runtime_readiness: "not_evaluated",
              }
            : {}),
          usage: r.usage,
        }));

        const ctx: AgentContext = {
          command: "core.search",
          duration_ms: Date.now() - searchStarted,
          surface: "web",
        };

        console.log(
          format(
            rows,
            ["command", "description", "operator", "effect", "score", "usage"],
            fmt,
            ctx,
          ),
        );
      },
    );
}
