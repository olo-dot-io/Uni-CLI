/**
 * @owner   src/engine/objective/catalog.ts
 * @does    Resolves objective command references against the live Uni-CLI registry.
 * @needs   src/registry.ts, src/engine/objective/types.ts
 * @feeds   src/engine/objective/planner.ts, src/engine/objective/output.ts
 * @breaks  If dotted command parsing drifts, objective strategies may claim commands that cannot execute.
 * @invariants Objective command refs use `site.command`; CLI strings are derived, never hand-written in workflows.
 * @side-effects none.
 * @perf    O(1) registry lookup per command reference.
 * @concurrency pure wrapper over read-only registry state.
 * @test    tests/unit/objective-compiler.test.ts
 * @stability experimental
 * @since   2026-06-01
 */

import { resolveCommand } from "../../registry.js";
import type { ObjectiveCommandCatalog } from "./types.js";

export interface ParsedObjectiveCommand {
  site: string;
  command: string;
}

export function createRegistryObjectiveCatalog(): ObjectiveCommandCatalog {
  return {
    hasCommand(command: string): boolean {
      const parsed = parseObjectiveCommand(command);
      return parsed
        ? resolveCommand(parsed.site, parsed.command) !== undefined
        : false;
    },
  };
}

export function objectiveCommandToCli(command: string): string {
  const parsed = parseObjectiveCommand(command);
  if (!parsed) return `unicli unknown ${command}`;
  return `unicli ${parsed.site} ${parsed.command}`;
}

export function parseObjectiveCommand(
  command: string,
): ParsedObjectiveCommand | undefined {
  const trimmed = command.trim();
  const index = trimmed.indexOf(".");
  if (index < 1 || index >= trimmed.length - 1) return undefined;
  return {
    site: trimmed.slice(0, index),
    command: trimmed.slice(index + 1),
  };
}
