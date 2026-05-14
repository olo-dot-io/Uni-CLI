/**
 * @owner   src/fast-path.ts
 * @does    Argv parsing and dispatch for discovery surfaces (list/search/describe/repair, plus pre-Commander adapter dry-run, policy gate, and site help).
 * @needs   ./fast-path/{manifest,parsed-argv,render,policy,handlers/discovery,handlers/adapter}, ./types (OutputFormat)
 * @feeds   src/main.ts (dispatched before the full Commander tree loads)
 * @breaks  Missing dist/manifest.json → returns false so caller falls through to Commander; structured errors propagate via emitStderrAndExit.
 */

import { type OutputFormat } from "./types.js";
import {
  handleAdapterDryRun,
  handleAdapterPolicyGate,
  handleSiteHelp,
} from "./fast-path/handlers/adapter.js";
import { handleApprovals } from "./fast-path/handlers/approvals.js";
import {
  handleDescribe,
  handleList,
  handleRepair,
  handleSearch,
} from "./fast-path/handlers/discovery.js";
import { isMissingManifestError } from "./fast-path/manifest.js";
import type { ParsedArgv } from "./fast-path/parsed-argv.js";
import { DEFAULT_IO, type Io, isOutputFormat } from "./fast-path/render.js";

export type { Io } from "./fast-path/render.js";
export type { ParsedArgv } from "./fast-path/parsed-argv.js";

interface ParseAccumulator {
  formatValue?: OutputFormat;
  dryRun: boolean;
  permissionProfile?: string;
  yes: boolean;
  rememberApproval: boolean;
  record: boolean;
}

/**
 * Try to consume one global flag at `args[i]`. Returns the new index
 * (i + skipped tokens) or `null` when the arg is not a recognized flag.
 * The single source of truth — adding a flag means editing one branch
 * here, not two parallel passes (rule 02 third-copy halt).
 */
function tryConsumeFlag(
  args: string[],
  i: number,
  acc: ParseAccumulator,
): number | null {
  const arg = args[i];

  if (arg === "-f" || arg === "--format") {
    const next = args[i + 1];
    if (next && isOutputFormat(next)) {
      acc.formatValue = next;
      return i + 1;
    }
    return null;
  }
  if (arg.startsWith("--format=")) {
    const next = arg.slice("--format=".length);
    if (isOutputFormat(next)) {
      acc.formatValue = next;
      return i;
    }
    return null;
  }
  if (arg === "--dry-run") {
    acc.dryRun = true;
    return i;
  }
  if (arg === "--permission-profile") {
    acc.permissionProfile = args[i + 1];
    return i + 1;
  }
  if (arg.startsWith("--permission-profile=")) {
    acc.permissionProfile = arg.slice("--permission-profile=".length);
    return i;
  }
  if (arg === "--yes") {
    acc.yes = true;
    return i;
  }
  if (arg === "--remember-approval") {
    acc.rememberApproval = true;
    return i;
  }
  if (arg === "--record") {
    acc.record = true;
    return i;
  }
  return null;
}

function parseArgv(argv: string[]): ParsedArgv {
  const args = argv.slice(2);
  const acc: ParseAccumulator = {
    dryRun: false,
    yes: false,
    rememberApproval: false,
    record: false,
  };
  let command: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const consumed = tryConsumeFlag(args, i, acc);
    if (consumed !== null) {
      i = consumed;
      continue;
    }
    const arg = args[i];
    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }
    rest.push(arg);
  }

  return {
    command,
    rest,
    format: acc.formatValue,
    dryRun: acc.dryRun,
    permissionProfile: acc.permissionProfile,
    yes: acc.yes,
    rememberApproval: acc.rememberApproval,
    record: acc.record,
  };
}

export function tryRunFastPath(
  argv = process.argv,
  io: Io = DEFAULT_IO,
): boolean {
  const parsed = parseArgv(argv);
  try {
    switch (parsed.command) {
      case "list":
        return handleList(parsed, io);
      case "search":
        return handleSearch(parsed, io);
      case "describe":
        return handleDescribe(parsed, io);
      case "repair":
        return handleRepair(parsed, io);
      case "approvals":
        return handleApprovals(parsed, io);
      default:
        return (
          handleAdapterPolicyGate(parsed, io) ||
          handleAdapterDryRun(parsed, io) ||
          handleSiteHelp(parsed, io)
        );
    }
  } catch (error) {
    if (isMissingManifestError(error)) return false;
    throw error;
  }
}
