import type { Command } from "commander";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx, type AgentError } from "../output/envelope.js";
import { ExitCode, type OutputFormat } from "../types.js";
import {
  clearStoredApprovals,
  createApprovalStore,
  listActiveStoredApprovals,
  revokeStoredApproval,
  type ApprovalStore,
  type StoredApproval,
} from "../engine/approval-store.js";
import type { CapabilityDimensionName } from "../engine/capability-policy.js";

interface ApprovalCommandOptions {
  store?: string;
}

function fmt(program: Command): OutputFormat {
  return detectFormat(program.opts().format as OutputFormat | undefined);
}

function storeFromOptions(opts: ApprovalCommandOptions): ApprovalStore {
  return createApprovalStore({ path: opts.store });
}

function projectApproval(entry: StoredApproval): Record<string, unknown> {
  return {
    key: entry.key,
    profile: entry.profile,
    created_at: entry.created_at,
    command: entry.command,
    scope_summary: scopeSummary(entry),
    scope: entry.scope,
  };
}

function scopeSummary(entry: StoredApproval): string[] {
  const order: CapabilityDimensionName[] = [
    "network",
    "browser",
    "desktop",
    "file",
    "process",
    "account",
  ];
  return order.flatMap((name) => {
    const access = entry.scope.dimensions[name];
    return access === "none" ? [] : [`${name}:${access}`];
  });
}

function printApprovalError(
  program: Command,
  command: string,
  startedAt: number,
  error: AgentError,
): void {
  process.exitCode = ExitCode.USAGE_ERROR;
  console.error(
    format(null, undefined, fmt(program), {
      ...makeCtx(command, startedAt),
      error,
    }),
  );
}

export function registerApprovalsCommand(program: Command): void {
  const approvals = program
    .command("approvals")
    .description("Inspect and revoke persisted approval memory");

  approvals
    .command("list")
    .description("List active persisted approvals")
    .option("--store <path>", "Override approval store path")
    .action(async (opts: ApprovalCommandOptions) => {
      const startedAt = Date.now();
      const store = storeFromOptions(opts);
      const active = await listActiveStoredApprovals(store);
      console.log(
        format(
          {
            store_path: store.path,
            approvals: active.map(projectApproval),
          },
          undefined,
          fmt(program),
          makeCtx("approvals.list", startedAt),
        ),
      );
    });

  approvals
    .command("revoke <key>")
    .description("Revoke one persisted approval by key")
    .option("--store <path>", "Override approval store path")
    .action(async (key: string, opts: ApprovalCommandOptions) => {
      const startedAt = Date.now();
      const store = storeFromOptions(opts);
      try {
        const revoked = await revokeStoredApproval(store, key);
        console.log(
          format(
            {
              store_path: store.path,
              key,
              revoked: Boolean(revoked),
              approval: revoked ? projectApproval(revoked) : null,
            },
            undefined,
            fmt(program),
            makeCtx("approvals.revoke", startedAt),
          ),
        );
      } catch (error) {
        printApprovalError(program, "approvals.revoke", startedAt, {
          code: "internal_error",
          message:
            error instanceof Error
              ? error.message
              : "failed to revoke approval",
          retryable: false,
        });
      }
    });

  approvals
    .command("clear")
    .description("Revoke all active persisted approvals")
    .option("--store <path>", "Override approval store path")
    .action(async (opts: ApprovalCommandOptions) => {
      const startedAt = Date.now();
      const store = storeFromOptions(opts);
      try {
        const cleared = await clearStoredApprovals(store);
        console.log(
          format(
            {
              store_path: store.path,
              cleared,
            },
            undefined,
            fmt(program),
            makeCtx("approvals.clear", startedAt),
          ),
        );
      } catch (error) {
        printApprovalError(program, "approvals.clear", startedAt, {
          code: "internal_error",
          message:
            error instanceof Error
              ? error.message
              : "failed to clear approvals",
          retryable: false,
        });
      }
    });
}
