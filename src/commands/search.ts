/**
 * Search command — bilingual semantic search across all adapters.
 *
 * Usage:
 *   unicli search "推特热门"           → finds twitter/trending
 *   unicli search "download video"     → finds bilibili/download, youtube/download, ...
 *   unicli search "股票行情"           → finds xueqiu/stock, eastmoney/stock, ...
 *   unicli search --category finance   → lists all finance commands
 */

import { Command } from "commander";
import chalk from "chalk";
import { search } from "../discovery/search.js";
import { format, detectFormat } from "../output/formatter.js";
import type { OutputFormat } from "../types.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search [query...]")
    .description(
      "Search commands by intent (bilingual). Example: unicli search 推特热门",
    )
    .option("-n, --limit <n>", "max results", "8")
    .option("--category <cat>", "filter by category")
    .action(
      (queryParts: string[], opts: { limit: string; category?: string }) => {
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

        const effectiveQuery = opts.category
          ? `${opts.category} ${query}`.trim()
          : query;

        const results = search(effectiveQuery, limit);

        if (results.length === 0) {
          console.error(
            chalk.yellow(`No commands found for: ${effectiveQuery}`),
          );
          process.exitCode = 66; // EX_EMPTY
          return;
        }

        const fmt = detectFormat(
          program.parent?.opts().format as OutputFormat | undefined,
        );

        const rows = results.map((r) => ({
          command: `${r.site} ${r.command}`,
          description: r.description || `${r.command} for ${r.site}`,
          score: r.score,
          category: r.category,
          usage: r.usage,
        }));

        console.log(
          format(rows, ["command", "description", "score", "usage"], fmt),
        );
      },
    );
}
