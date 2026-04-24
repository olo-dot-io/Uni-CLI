/**
 * Coding-agent backend policy subcommands for `unicli agents`.
 */

import type { Command } from "commander";
import {
  buildAgentBackendMatrix,
  recommendAgentBackend,
} from "../agents/backends.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";

export function registerAgentBackendCommands(
  agents: Command,
  program: Command,
): void {
  agents
    .command("matrix")
    .description("Show the coding-agent backend route matrix")
    .action(() => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      const ctx = makeCtx("agents.matrix", startedAt, { surface: "system" });
      console.log(format(buildAgentBackendMatrix(), undefined, fmt, ctx));
    });

  agents
    .command("recommend <agent>")
    .description("Recommend the fastest reliable route for one coding agent")
    .action((agent: string) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      const ctx = makeCtx("agents.recommend", startedAt, {
        surface: "system",
      });

      try {
        const recommendation = recommendAgentBackend(agent);
        console.log(
          format(
            {
              backend: recommendation.backend,
              route: recommendation.route,
              fallbacks: recommendation.fallbacks,
              rationale: recommendation.rationale,
              risks: recommendation.risks,
            },
            undefined,
            fmt,
            ctx,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.error = {
          code: "invalid_input",
          message,
          suggestion: "Run `unicli agents matrix` to see supported backends.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, ctx));
        process.exitCode = 2;
      }
    });
}
