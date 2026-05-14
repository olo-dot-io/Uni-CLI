/**
 * @owner   src/fast-path/handlers/approvals.ts
 * @does    Handles lightweight approval-memory CLI commands before full adapter startup.
 * @needs   ParsedArgv, approval-store sync APIs, and shared approval projection.
 * @feeds   src/fast-path.ts approvals dispatch case.
 * @breaks  Commander approvals syntax changes must be mirrored by this handler.
 */

import {
  clearStoredApprovalsSync,
  createApprovalStore,
  listActiveStoredApprovalsSync,
  revokeStoredApprovalSync,
} from "../../engine/approval-store.js";
import { projectApproval } from "../../engine/approval-presenter.js";
import { makeCtx, type AgentError } from "../../output/envelope.js";
import { detectFormat, format } from "../../output/formatter.js";
import { ExitCode } from "../../types.js";
import type { ParsedArgv } from "../parsed-argv.js";
import { emit, type Io } from "../render.js";

interface ApprovalFastArgs {
  subcommand?: string;
  key?: string;
  store?: string;
  error?: string;
}

export function handleApprovals(parsed: ParsedArgv, io: Io): boolean {
  const args = parseApprovalArgs(parsed.rest);
  if (!args.subcommand) return false;

  const startedAt = Date.now();
  if (args.error) {
    emitApprovalInputError(
      parsed,
      io,
      approvalCommandName(args.subcommand),
      startedAt,
      args.error,
    );
    return true;
  }

  const store = createApprovalStore({ path: args.store });

  if (args.subcommand === "list") {
    const active = listActiveStoredApprovalsSync(store);
    emit(
      io,
      {
        store_path: store.path,
        approvals: active.map(projectApproval),
      },
      undefined,
      parsed.format,
      "approvals.list",
      startedAt,
    );
    return true;
  }

  if (args.subcommand === "revoke") {
    if (!args.key) {
      emitApprovalInputError(
        parsed,
        io,
        "approvals.revoke",
        startedAt,
        "Usage: unicli approvals revoke <key>",
      );
      return true;
    }
    try {
      const revoked = revokeStoredApprovalSync(store, args.key);
      emit(
        io,
        {
          store_path: store.path,
          key: args.key,
          revoked: Boolean(revoked),
          approval: revoked ? projectApproval(revoked) : null,
        },
        undefined,
        parsed.format,
        "approvals.revoke",
        startedAt,
      );
    } catch (error) {
      emitApprovalError(parsed, io, "approvals.revoke", startedAt, {
        code: "internal_error",
        message:
          error instanceof Error ? error.message : "failed to revoke approval",
        retryable: false,
      });
    }
    return true;
  }

  if (args.subcommand === "clear") {
    try {
      const cleared = clearStoredApprovalsSync(store);
      emit(
        io,
        {
          store_path: store.path,
          cleared,
        },
        undefined,
        parsed.format,
        "approvals.clear",
        startedAt,
      );
    } catch (error) {
      emitApprovalError(parsed, io, "approvals.clear", startedAt, {
        code: "internal_error",
        message:
          error instanceof Error ? error.message : "failed to clear approvals",
        retryable: false,
      });
    }
    return true;
  }

  return false;
}

function parseApprovalArgs(rest: string[]): ApprovalFastArgs {
  const args: ApprovalFastArgs = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--store") {
      const value = rest[i + 1];
      if (!value || value.startsWith("-")) {
        return {
          ...args,
          error: "Option --store requires a path value.",
        };
      }
      args.store = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--store=")) {
      const value = token.slice("--store=".length);
      if (!value) {
        return {
          ...args,
          error: "Option --store requires a path value.",
        };
      }
      args.store = value;
      continue;
    }
    if (!args.subcommand) {
      args.subcommand = token;
      continue;
    }
    if (args.subcommand === "revoke" && !args.key) {
      args.key = token;
      continue;
    }
    return {};
  }
  return args;
}

function approvalCommandName(subcommand?: string): string {
  if (subcommand === "list") return "approvals.list";
  if (subcommand === "revoke") return "approvals.revoke";
  if (subcommand === "clear") return "approvals.clear";
  return "approvals";
}

function emitApprovalInputError(
  parsed: ParsedArgv,
  io: Io,
  command: string,
  startedAt: number,
  message: string,
): void {
  emitApprovalError(parsed, io, command, startedAt, {
    code: "invalid_input",
    message,
    retryable: false,
  });
}

function emitApprovalError(
  parsed: ParsedArgv,
  io: Io,
  command: string,
  startedAt: number,
  error: AgentError,
): void {
  io.stderr(
    format(null, undefined, detectFormat(parsed.format), {
      ...makeCtx(command, startedAt),
      error,
    }),
  );
  process.exitCode = ExitCode.USAGE_ERROR;
}
