/**
 * @owner   src/output/error-writer.ts
 * @does    Centralizes process-level emission of structured AgentEnvelope errors.
 * @needs   src/output/formatter.ts, src/output/envelope.ts, src/types.ts
 * @feeds   command modules that need stderr error envelopes with explicit exit codes.
 * @breaks  Writing errors to stdout pollutes agent data streams and violates the CLI contract.
 * @invariants error envelopes always go to stderr; process.exitCode is set before emission.
 * @side-effects writes to stderr and sets process.exitCode.
 * @perf    O(serialized envelope size).
 * @concurrency process-global exitCode and stderr make this CLI-process scoped.
 * @test    tests/unit/delivery-cli.test.ts, tests/unit/session-runs-command.test.ts, tests/unit/commands/extract.test.ts
 * @stability experimental
 * @since   2026-05-24
 */

import type { AgentContext } from "./envelope.js";
import { format } from "./formatter.js";
import type { OutputFormat } from "../types.js";

export function printErrorEnvelope(input: {
  columns?: string[];
  fmt: OutputFormat;
  ctx: AgentContext;
  exitCode: number;
}): void {
  process.exitCode = input.exitCode;
  console.error(format(null, input.columns, input.fmt, input.ctx));
}
