/**
 * @owner src/commands/architecture.ts
 * @does Exposes the callable architecture tree and lifecycle audit to agents.
 * @needs commander, src/core/architecture-tree, src/registry, src/output/formatter, src/output/envelope
 * @feeds src/cli.ts, tests/unit/commands/architecture.test.ts
 * @breaks Propagates architecture-tree construction errors when command metadata is malformed.
 * @invariants `architecture tree` and `architecture audit` both emit AgentEnvelope-compatible output.
 * @side-effects Writes formatted command output to stdout.
 * @perf O(commands) over the loaded adapter registry per invocation.
 * @concurrency Reentrant per Commander program instance.
 * @test tests/unit/commands/architecture.test.ts
 * @stability experimental
 * @since 2026-05-26
 */

import { Command } from "commander";
import {
  auditArchitectureTree,
  buildArchitectureTree,
} from "../core/architecture-tree.js";
import { getAllAdapters } from "../registry.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { AdapterManifest, OutputFormat } from "../types.js";

export interface RegisterArchitectureCommandOptions {
  getAdapters?: () => readonly AdapterManifest[];
}

function writeArchitectureEnvelope(
  program: Command,
  commandName: "architecture.tree" | "architecture.audit",
  startedAt: number,
  payload: Record<string, unknown>,
): void {
  const ctx = makeCtx(commandName, startedAt);
  ctx.duration_ms = Date.now() - startedAt;
  const fmt = detectFormat(program.opts().format as OutputFormat | undefined);
  console.log(format(payload, undefined, fmt, ctx));
}

export function registerArchitectureCommand(
  program: Command,
  options: RegisterArchitectureCommandOptions = {},
): void {
  const readAdapters = options.getAdapters ?? getAllAdapters;
  const architecture = program
    .command("architecture")
    .description("Inspect Uni-CLI's command lifecycle tree and rewrite audit");

  architecture
    .command("tree")
    .description("Emit the callable Uni-CLI architecture tree")
    .action(() => {
      const startedAt = Date.now();
      const tree = buildArchitectureTree({ adapters: readAdapters() });
      writeArchitectureEnvelope(
        program,
        "architecture.tree",
        startedAt,
        tree as unknown as Record<string, unknown>,
      );
    });

  architecture
    .command("audit")
    .description("Audit architecture tree readiness before restructuring")
    .action(() => {
      const startedAt = Date.now();
      const audit = auditArchitectureTree({ adapters: readAdapters() });
      writeArchitectureEnvelope(
        program,
        "architecture.audit",
        startedAt,
        audit as unknown as Record<string, unknown>,
      );
    });
}
