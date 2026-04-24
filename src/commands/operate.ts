/**
 * Interactive browser compatibility surface — `unicli operate`.
 *
 * `browser` is now the primary operator surface. `operate` remains as a
 * compatibility alias mounted over the same implementation so behavior cannot
 * drift between the two command trees.
 */

import { Command } from "commander";
import {
  applyBrowserOperatorRootOptions,
  registerBrowserOperatorSubcommands,
} from "./browser-operator.js";

export function registerOperateCommands(program: Command): void {
  const operate = program
    .command("operate")
    .description(
      "Interactive browser control for agents (compatibility alias; prefer `unicli browser`)",
    );

  applyBrowserOperatorRootOptions(operate);
  registerBrowserOperatorSubcommands(operate, program, "operate");
}
