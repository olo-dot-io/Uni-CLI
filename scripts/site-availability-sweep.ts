/**
 * @owner   scripts/site-availability-sweep.ts
 * @does    Classify every adapter command and execute one safe representative read probe per site.
 * @needs   src/discovery/loader.ts, src/registry.ts, src/core/command-contract.ts, src/engine/kernel/execute.ts, scripts/adapter-health-shared.ts
 * @feeds   npm run site:availability, release/operator audits, adapter repair triage.
 * @breaks  Unsafe command selection can mutate user state; weak classification can hide all-site health regressions behind skipped commands.
 * @invariants Only public read-only non-browser commands without required free-form input are executed automatically; every other command is reported with a reason.
 * @side-effects Runs bounded public read probes and platform-safe local read probes; writes no project files.
 * @perf    O(adapter commands) classification plus O(sites with safe read probes) execution.
 * @concurrency Sequential by design to avoid racing local desktop/browser state and upstream rate limits.
 * @test    tests/unit/site-availability-sweep.test.ts
 * @stability operator-facing verification script.
 * @since   2026-06-02
 */

import { pathToFileURL } from "node:url";
import { buildCommandContract } from "../src/core/command-contract.js";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import { buildInvocation, execute } from "../src/engine/kernel/execute.js";
import { getAllAdapters } from "../src/registry.js";
import type { AdapterCommand, AdapterManifest } from "../src/types.js";
import {
  detectFails,
  healthProbeArgs,
  isEnvironmentMissing,
  manualHealthReason,
  platformCapabilityMismatch,
  withTimeout,
} from "./adapter-health-shared.js";

export type CommandPosture =
  | "auto_runnable_read"
  | "auth_required"
  | "browser_required"
  | "environment_missing"
  | "platform_mismatch"
  | "quarantined"
  | "requires_input"
  | "write_or_destructive";

export interface CommandClassification {
  site: string;
  command: string;
  posture: CommandPosture;
  reason: string;
  score: number;
}

export interface SiteProbePlan {
  site: string;
  probe?: {
    command: string;
    args: Record<string, unknown>;
  };
  command_posture_counts: Record<CommandPosture, number>;
  primary_unprobed_reason?: CommandPosture;
  primary_unprobed_detail?: string;
}

export interface SiteProbeResult {
  site: string;
  status: "ok" | "environment_skip" | "no_auto_probe" | "fail";
  command?: string;
  reason?: string;
  error_code?: string;
  adapter_path?: string;
  latency_ms: number;
  row_count?: number;
}

export interface SiteAvailabilitySummary {
  schema_version: "site-availability-sweep.v1";
  platform: NodeJS.Platform;
  timeout_ms: number;
  site_total: number;
  command_total: number;
  command_posture_counts: Record<CommandPosture, number>;
  site_status_counts: Record<SiteProbeResult["status"], number>;
  concentrated_failures: Array<{ key: string; count: number; sites: string[] }>;
  environment_skips: Array<{ key: string; count: number; sites: string[] }>;
  no_auto_probe_reasons: Array<{
    posture: CommandPosture;
    count: number;
    sites: string[];
  }>;
  results: SiteProbeResult[];
}

interface BuildPlanOptions {
  platform?: NodeJS.Platform;
  runDetect?: boolean;
}

interface RunSweepOptions extends BuildPlanOptions {
  timeoutMs: number;
  onlySite?: string;
  reportOnly?: boolean;
}

const SAFE_NAME_BOOSTS = new Map<string, number>([
  ["status", 90],
  ["top", 85],
  ["trending", 84],
  ["hot", 83],
  ["latest", 82],
  ["list", 80],
  ["search", 70],
  ["show", 65],
  ["read", 65],
  ["info", 60],
  ["profile", 55],
]);

const RISKY_NAME_PATTERN =
  /\b(auth|comment|control|copy|create|delete|download|export|follow|import|like|login|move|open|play|post|publish|remove|run|send|start|stop|submit|upload|write)\b/i;

const SEMANTIC_INPUT_ARG_NAMES = new Set([
  "artist",
  "author",
  "character",
  "female",
  "gid",
  "group",
  "id",
  "input",
  "key",
  "language",
  "male",
  "mixed",
  "name",
  "namespace",
  "other",
  "parody",
  "pid",
  "q",
  "query",
  "tag",
  "tags",
  "token",
  "url",
]);

function increment<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function requiredArgsWithoutDefaults(command: AdapterCommand): string[] {
  return (command.adapterArgs ?? [])
    .filter((arg) => arg.required === true && arg.default === undefined)
    .map((arg) => arg.name);
}

function browserSubstrateReason(command: AdapterCommand): string | undefined {
  const capability = command.minimum_capability;
  if (!capability) return undefined;
  if (
    capability.startsWith("cdp-browser.") ||
    capability.startsWith("mcp-browser.")
  ) {
    return `requires browser substrate: ${capability}`;
  }
  if (capability.startsWith("visual.")) {
    return `requires visual substrate: ${capability}`;
  }
  return undefined;
}

function environmentSubstrateReason(
  command: AdapterCommand,
): string | undefined {
  const capability = command.minimum_capability;
  if (!capability) return undefined;
  if (capability.startsWith("net.websocket")) {
    return `requires local websocket service: ${capability}`;
  }
  return undefined;
}

function semanticInputReason(command: AdapterCommand): string | undefined {
  const missing = (command.adapterArgs ?? [])
    .filter((arg) => arg.default === undefined)
    .filter(
      (arg) =>
        arg.positional === true || SEMANTIC_INPUT_ARG_NAMES.has(arg.name),
    )
    .map((arg) => arg.name);
  if (missing.length === 0) return undefined;
  return `requires semantic input without default: ${missing.join(", ")}`;
}

function scoreCommand(commandName: string, command: AdapterCommand): number {
  const lower = commandName.toLowerCase();
  let score = 10;
  for (const [token, boost] of SAFE_NAME_BOOSTS) {
    if (lower === token) score += boost;
    else if (lower.includes(token)) score += Math.floor(boost / 2);
  }
  if ((command.adapterArgs ?? []).some((arg) => arg.name === "limit")) {
    score += 10;
  }
  if ((command.adapterArgs ?? []).length === 0) score += 6;
  if (command.pipeline) score += 4;
  if (RISKY_NAME_PATTERN.test(lower)) score -= 30;
  return score;
}

export function classifyCommand(input: {
  adapter: AdapterManifest;
  commandName: string;
  command: AdapterCommand;
  platform?: NodeJS.Platform;
  detectReason?: string;
}): CommandClassification {
  const { adapter, commandName, command } = input;
  const platform = input.platform ?? process.platform;
  const ref = { site: adapter.name, command: commandName };

  if (command.quarantine) {
    return {
      ...ref,
      posture: "quarantined",
      reason: command.quarantineReason ?? "command is quarantined",
      score: 0,
    };
  }

  const platformReason = platformCapabilityMismatch(
    command.minimum_capability,
    platform,
  );
  if (platformReason) {
    return {
      ...ref,
      posture: "platform_mismatch",
      reason: platformReason,
      score: 0,
    };
  }

  if (input.detectReason) {
    return {
      ...ref,
      posture: "environment_missing",
      reason: input.detectReason,
      score: 0,
    };
  }

  const contract = buildCommandContract({ adapter, commandName, command });
  if (contract.auth.required) {
    return {
      ...ref,
      posture: "auth_required",
      reason: contract.auth.setup_command ?? "authentication required",
      score: 0,
    };
  }
  const substrateReason = browserSubstrateReason(command);
  if (substrateReason) {
    return {
      ...ref,
      posture: "browser_required",
      reason: substrateReason,
      score: 0,
    };
  }
  const environmentReason = environmentSubstrateReason(command);
  if (environmentReason) {
    return {
      ...ref,
      posture: "environment_missing",
      reason: environmentReason,
      score: 0,
    };
  }
  if (contract.effect.browser) {
    return {
      ...ref,
      posture: "browser_required",
      reason: "requires browser/CDP or UI substrate",
      score: 0,
    };
  }
  if (contract.effect.safety_class !== "read") {
    return {
      ...ref,
      posture: "write_or_destructive",
      reason: contract.effect.operation_effect,
      score: 0,
    };
  }

  const manualReason = manualHealthReason(adapter.name, commandName);
  if (manualReason) {
    return {
      ...ref,
      posture: "write_or_destructive",
      reason: manualReason,
      score: 0,
    };
  }

  const requiredArgs = requiredArgsWithoutDefaults(command);
  if (requiredArgs.length > 0) {
    return {
      ...ref,
      posture: "requires_input",
      reason: `requires args without default: ${requiredArgs.join(", ")}`,
      score: 0,
    };
  }
  const semanticReason = semanticInputReason(command);
  if (semanticReason) {
    return {
      ...ref,
      posture: "requires_input",
      reason: semanticReason,
      score: 0,
    };
  }

  return {
    ...ref,
    posture: "auto_runnable_read",
    reason: "read-only, public, non-browser, no required args",
    score: scoreCommand(commandName, command),
  };
}

export function buildSiteProbePlans(
  adapters: readonly AdapterManifest[],
  options: BuildPlanOptions = {},
): {
  commandClassifications: CommandClassification[];
  sitePlans: SiteProbePlan[];
  commandPostureCounts: Record<CommandPosture, number>;
} {
  const commandClassifications: CommandClassification[] = [];
  const sitePlans: SiteProbePlan[] = [];
  const commandPostureCounts = {} as Record<CommandPosture, number>;

  for (const adapter of adapters) {
    const detectReason =
      options.runDetect === true ? detectFails(adapter.detect) : undefined;
    const siteCounts = {} as Record<CommandPosture, number>;
    const siteRows: CommandClassification[] = [];

    for (const [commandName, command] of Object.entries(adapter.commands)) {
      const classification = classifyCommand({
        adapter,
        commandName,
        command,
        platform: options.platform,
        detectReason,
      });
      commandClassifications.push(classification);
      siteRows.push(classification);
      increment(commandPostureCounts, classification.posture);
      increment(siteCounts, classification.posture);
    }

    const probe = siteRows
      .filter((row) => row.posture === "auto_runnable_read")
      .sort(
        (left, right) =>
          right.score - left.score || left.command.localeCompare(right.command),
      )[0];
    const primary = dominantNonAutoReason(siteRows);
    const probeCommand = probe ? adapter.commands[probe.command] : undefined;
    sitePlans.push({
      site: adapter.name,
      ...(probe && probeCommand
        ? {
            probe: {
              command: probe.command,
              args: healthProbeArgs(probeCommand),
            },
          }
        : {}),
      command_posture_counts: siteCounts,
      ...(probe
        ? {}
        : {
            primary_unprobed_reason: primary?.posture,
            primary_unprobed_detail: primary?.reason,
          }),
    });
  }

  return {
    commandClassifications: commandClassifications.sort(
      (left, right) =>
        left.site.localeCompare(right.site) ||
        left.command.localeCompare(right.command),
    ),
    sitePlans: sitePlans.sort((left, right) =>
      left.site.localeCompare(right.site),
    ),
    commandPostureCounts,
  };
}

function dominantNonAutoReason(
  rows: readonly CommandClassification[],
): CommandClassification | undefined {
  const grouped = new Map<
    CommandPosture,
    { count: number; first: CommandClassification }
  >();
  for (const row of rows) {
    if (row.posture === "auto_runnable_read") continue;
    const existing = grouped.get(row.posture);
    if (existing) existing.count += 1;
    else grouped.set(row.posture, { count: 1, first: row });
  }
  return Array.from(grouped.values()).sort(
    (left, right) =>
      right.count - left.count ||
      posturePriority(left.first.posture) -
        posturePriority(right.first.posture),
  )[0]?.first;
}

function posturePriority(posture: CommandPosture): number {
  switch (posture) {
    case "auth_required":
      return 0;
    case "requires_input":
      return 1;
    case "browser_required":
      return 2;
    case "write_or_destructive":
      return 3;
    case "environment_missing":
      return 4;
    case "platform_mismatch":
      return 5;
    case "quarantined":
      return 6;
    case "auto_runnable_read":
      return 7;
  }
}

async function runSiteProbe(
  adapter: AdapterManifest,
  plan: SiteProbePlan,
  timeoutMs: number,
): Promise<SiteProbeResult> {
  if (!plan.probe) {
    return {
      site: plan.site,
      status: "no_auto_probe",
      reason: plan.primary_unprobed_detail ?? plan.primary_unprobed_reason,
      latency_ms: 0,
    };
  }

  const startedAt = Date.now();
  const invocation = buildInvocation("cli", adapter.name, plan.probe.command, {
    args: plan.probe.args,
    source: "internal",
  });
  if (!invocation) {
    return {
      site: plan.site,
      command: plan.probe.command,
      status: "fail",
      reason: "internal registry lookup failed",
      error_code: "internal_error",
      latency_ms: Date.now() - startedAt,
    };
  }

  try {
    const result = await withTimeout(execute(invocation), timeoutMs);
    if (result.error) {
      const envReason = isEnvironmentMissing(
        `${result.error.code} ${result.error.message} ${result.error.suggestion ?? ""}`,
      );
      if (envReason) {
        return {
          site: plan.site,
          command: plan.probe.command,
          status: "environment_skip",
          reason: envReason,
          error_code: result.error.code,
          adapter_path: result.error.adapter_path,
          latency_ms: Date.now() - startedAt,
        };
      }
      return {
        site: plan.site,
        command: plan.probe.command,
        status: "fail",
        reason: result.error.message,
        error_code: result.error.code,
        adapter_path: result.error.adapter_path,
        latency_ms: Date.now() - startedAt,
      };
    }
    return {
      site: plan.site,
      command: plan.probe.command,
      status: "ok",
      latency_ms: Date.now() - startedAt,
      row_count: result.results.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const envReason = isEnvironmentMissing(message);
    if (envReason) {
      return {
        site: plan.site,
        command: plan.probe.command,
        status: "environment_skip",
        reason: envReason,
        error_code: "environment_missing",
        latency_ms: Date.now() - startedAt,
      };
    }
    return {
      site: plan.site,
      command: plan.probe.command,
      status: "fail",
      reason: message.slice(0, 240),
      error_code: "probe_error",
      latency_ms: Date.now() - startedAt,
    };
  }
}

function summarizeGroups(
  results: readonly SiteProbeResult[],
  status: SiteProbeResult["status"],
): Array<{ key: string; count: number; sites: string[] }> {
  const groups = new Map<string, string[]>();
  for (const result of results) {
    if (result.status !== status) continue;
    const key = `${result.error_code ?? "unknown"}: ${result.reason ?? "unknown"}`;
    const sites = groups.get(key) ?? [];
    sites.push(result.site);
    groups.set(key, sites);
  }
  return Array.from(groups.entries())
    .map(([key, sites]) => ({
      key,
      count: sites.length,
      sites: sites.sort(),
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.key.localeCompare(right.key),
    );
}

function summarizeNoAutoProbe(
  plans: readonly SiteProbePlan[],
  results: readonly SiteProbeResult[],
): SiteAvailabilitySummary["no_auto_probe_reasons"] {
  const noProbeSites = new Set(
    results
      .filter((result) => result.status === "no_auto_probe")
      .map((result) => result.site),
  );
  const groups = new Map<CommandPosture, string[]>();
  for (const plan of plans) {
    if (!noProbeSites.has(plan.site)) continue;
    const posture = plan.primary_unprobed_reason ?? "requires_input";
    const sites = groups.get(posture) ?? [];
    sites.push(plan.site);
    groups.set(posture, sites);
  }
  return Array.from(groups.entries())
    .map(([posture, sites]) => ({
      posture,
      count: sites.length,
      sites: sites.sort(),
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.posture.localeCompare(right.posture),
    );
}

function siteStatusCounts(
  results: readonly SiteProbeResult[],
): Record<SiteProbeResult["status"], number> {
  const counts: Record<SiteProbeResult["status"], number> = {
    ok: 0,
    environment_skip: 0,
    no_auto_probe: 0,
    fail: 0,
  };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

export async function runSiteAvailabilitySweep(
  options: RunSweepOptions,
): Promise<SiteAvailabilitySummary> {
  loadAllAdapters();
  await loadTsAdapters();

  const adapters = getAllAdapters()
    .filter((adapter) => !options.onlySite || adapter.name === options.onlySite)
    .sort((left, right) => left.name.localeCompare(right.name));
  const { sitePlans, commandClassifications, commandPostureCounts } =
    buildSiteProbePlans(adapters, {
      platform: options.platform,
      runDetect: options.runDetect,
    });

  const adaptersBySite = new Map(
    adapters.map((adapter) => [adapter.name, adapter]),
  );
  const results: SiteProbeResult[] = [];
  for (const plan of sitePlans) {
    const adapter = adaptersBySite.get(plan.site);
    if (!adapter) continue;
    results.push(await runSiteProbe(adapter, plan, options.timeoutMs));
  }

  return {
    schema_version: "site-availability-sweep.v1",
    platform: options.platform ?? process.platform,
    timeout_ms: options.timeoutMs,
    site_total: adapters.length,
    command_total: commandClassifications.length,
    command_posture_counts: commandPostureCounts,
    site_status_counts: siteStatusCounts(results),
    concentrated_failures: summarizeGroups(results, "fail"),
    environment_skips: summarizeGroups(results, "environment_skip"),
    no_auto_probe_reasons: summarizeNoAutoProbe(sitePlans, results),
    results,
  };
}

async function main(): Promise<void> {
  const summary = await runSiteAvailabilitySweep({
    timeoutMs: Number(process.env.SITE_SWEEP_TIMEOUT_MS ?? 10_000),
    onlySite: process.env.SITE_SWEEP_SITE,
    reportOnly: process.env.SITE_SWEEP_REPORT_ONLY === "1",
    runDetect: process.env.SITE_SWEEP_DETECT !== "0",
  });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (
    summary.site_status_counts.fail > 0 &&
    process.env.SITE_SWEEP_REPORT_ONLY !== "1"
  ) {
    process.stderr.write(
      `site-availability: ${summary.site_status_counts.fail} site${summary.site_status_counts.fail === 1 ? "" : "s"} failed representative probes\n`,
    );
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((err) => {
    process.stderr.write(
      `site-availability-sweep: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
