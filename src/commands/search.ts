/**
 * Search command — intent search across all adapters.
 *
 * Usage:
 *   unicli search "twitter trending"  → finds twitter/trending
 *   unicli search "download video"     → finds bilibili/download, youtube/download, ...
 *   unicli search "stock price"       → finds xueqiu/stock, eastmoney/stock, ...
 *   unicli search --category finance   → lists all finance commands
 */

import { Command } from "commander";
import chalk from "chalk";
import { search } from "../discovery/search.js";
import { format, detectFormat } from "../output/formatter.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { emptySearchResultError } from "../output/error-map.js";
import type { AgentContext } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search [query...]")
    .description(
      "Search commands by intent. Example: unicli search twitter trending",
    )
    .option("-n, --limit <n>", "max results", "8")
    .option("--category <cat>", "filter by category")
    .action(
      (queryParts: string[], opts: { limit: string; category?: string }) => {
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

        const results = search(query, limit, { category: opts.category });

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
          usage: r.usage,
        }));

        const ctx: AgentContext = {
          command: "core.search",
          duration_ms: Date.now() - searchStarted,
          surface: "web",
        };

        console.log(
          format(rows, ["command", "description", "score", "usage"], fmt, ctx),
        );
      },
    );
}
