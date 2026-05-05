/**
 * Fast-path adapter-level handlers — adapter-dry-run / adapter-policy-gate /
 * site-help.
 *
 * These intercept `unicli <site> <cmd> ...` BEFORE Commander loads the full
 * adapter tree, either to render a dry-run plan, gate on permission policy,
 * or print site-level help. Each returns true if the fast path consumed the
 * call.
 */

import {
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../../engine/operation-policy.js";
import { defaultErrorNextActions } from "../../output/next-actions.js";
import { format, detectFormat } from "../../output/formatter.js";
import { ExitCode } from "../../types.js";
import { readManifest } from "../manifest.js";
import type { ParsedArgv } from "../parsed-argv.js";
import { evaluateManifestOperationPolicy } from "../policy.js";
import {
  emitStderrAndExit,
  type Io,
  isHelpToken,
  resolveDryRunArgs,
} from "../render.js";

export function handleAdapterDryRun(parsed: ParsedArgv, io: Io): boolean {
  if (!parsed.command || !parsed.dryRun || parsed.rest.length === 0) {
    return false;
  }

  const manifest = readManifest();
  const info = manifest.sites[parsed.command];
  if (!info) return false;

  const [cmdName, ...tokens] = parsed.rest;
  if (!cmdName || cmdName === "help" || cmdName.startsWith("-")) return false;

  const command = info.commands.find((candidate) => candidate.name === cmdName);
  if (!command) return false;

  const startedAt = Date.now();
  const args = resolveDryRunArgs(command.args, tokens);
  if (!args) return false;
  const adapterType = command.type ?? info.commands[0]?.type ?? "web-api";
  const targetSurface = resolveOperationTargetSurface({
    adapterType,
    targetSurface: command.target_surface,
  });
  const adapterPath = resolveOperationAdapterPath(
    parsed.command,
    cmdName,
    command.adapter_path,
  );
  const operationPolicy = evaluateManifestOperationPolicy({
    parsed,
    io,
    site: parsed.command,
    commandName: cmdName,
    command,
    adapterType,
    targetSurface,
    adapterPath,
    startedAt,
  });
  if (!operationPolicy) return true;

  io.stdout(
    JSON.stringify(
      {
        command: `${parsed.command}.${cmdName}`,
        adapter_type: adapterType,
        strategy: command.strategy ?? "public",
        args,
        args_source: tokens.length > 0 ? "shell" : "defaults",
        operation_policy: operationPolicy,
        trace_id: `fast-${Date.now().toString(36)}`,
        surface: "cli",
        target_surface: targetSurface,
        pipeline_steps: command.pipeline_steps ?? 0,
        adapter_path: adapterPath,
      },
      null,
      2,
    ),
  );
  return true;
}

export function handleAdapterPolicyGate(parsed: ParsedArgv, io: Io): boolean {
  if (!parsed.command || parsed.dryRun || parsed.rest.length === 0) {
    return false;
  }

  const [cmdName] = parsed.rest;
  if (!cmdName || cmdName === "help" || cmdName.startsWith("-")) return false;
  if (parsed.rest.slice(1).some(isHelpToken)) return false;

  const startedAt = Date.now();
  const manifest = readManifest();
  const info = manifest.sites[parsed.command];
  if (!info) return false;

  const command = info.commands.find((candidate) => candidate.name === cmdName);
  if (!command) return false;

  const adapterType = command.type ?? info.commands[0]?.type ?? "web-api";
  const targetSurface = resolveOperationTargetSurface({
    adapterType,
    targetSurface: command.target_surface,
  });
  const adapterPath = resolveOperationAdapterPath(
    parsed.command,
    cmdName,
    command.adapter_path,
  );

  const operationPolicy = evaluateManifestOperationPolicy({
    parsed,
    io,
    site: parsed.command,
    commandName: cmdName,
    command,
    adapterType,
    targetSurface,
    adapterPath,
    startedAt,
  });
  if (!operationPolicy) return true;

  if (
    operationPolicy.enforcement !== "needs_approval" &&
    operationPolicy.enforcement !== "deny"
  ) {
    return false;
  }

  const isDenyRule = operationPolicy.enforcement === "deny";
  const ruleId = operationPolicy.deny_rule?.id ?? "unknown";
  const ruleReason =
    operationPolicy.deny_rule?.reason ?? "permission rule matched";

  emitStderrAndExit(
    io,
    format([], command.columns, detectFormat(parsed.format), {
      command: `${parsed.command}.${cmdName}`,
      duration_ms: Date.now() - startedAt,
      surface: targetSurface,
      error: {
        code: "permission_denied",
        message: isDenyRule
          ? `permission rule "${ruleId}" denies ${operationPolicy.effect}: ${ruleReason}`
          : `permission profile "${operationPolicy.profile}" requires approval for ${operationPolicy.effect}`,
        adapter_path: adapterPath,
        step: 0,
        suggestion:
          operationPolicy.approval_hint ??
          (isDenyRule
            ? "edit or remove the matching permission rule"
            : "rerun with --yes or use --permission-profile open"),
        retryable: false,
        alternatives: isDenyRule
          ? [
              `unicli --dry-run ${parsed.command} ${cmdName}`,
              "edit ~/.unicli/permission-rules.json",
            ]
          : [
              `unicli --dry-run ${parsed.command} ${cmdName}`,
              `unicli --yes --permission-profile ${operationPolicy.profile} ${parsed.command} ${cmdName}`,
              `unicli --permission-profile open ${parsed.command} ${cmdName}`,
            ],
      },
      next_actions: defaultErrorNextActions(
        parsed.command,
        cmdName,
        "permission_denied",
      ),
    }),
    ExitCode.AUTH_REQUIRED,
  );
  return true;
}

export function handleSiteHelp(parsed: ParsedArgv, io: Io): boolean {
  const wantsHelp = parsed.rest.length === 0 || parsed.rest.every(isHelpToken);
  if (!parsed.command || !wantsHelp) return false;

  const manifest = readManifest();
  const info = manifest.sites[parsed.command];
  if (!info) return false;

  const commandWidth = Math.max(
    7,
    ...info.commands.map((command) => command.name.length),
  );
  const lines = [
    `Usage: unicli ${parsed.command} [options] [command]`,
    "",
    `Commands for ${parsed.command}`,
    "",
    "Options:",
    "  -h, --help".padEnd(commandWidth + 6) + "display help for command",
    "",
    "Commands:",
  ];
  for (const command of info.commands) {
    lines.push(
      `  ${command.name.padEnd(commandWidth)}  ${command.description ?? ""}`.trimEnd(),
    );
  }
  lines.push(
    `  ${"help [command]".padEnd(commandWidth)}  display help for command`,
  );
  io.stdout(lines.join("\n"));
  return true;
}
