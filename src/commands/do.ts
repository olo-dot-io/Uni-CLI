/**
 * @owner        src/commands/do.ts
 * @does         One-call intent → objective plan or ranked command plan.
 *               Natural-language goals that describe an end state compile
 *               into objective-level strategies before BM25 command search;
 *               otherwise the best-fitting adapter command is returned with a
 *               schema-aware invocation template. Intentionally plan-only —
 *               agents explicitly invoke the suggested command on the second
 *               hop.
 * @needs        commander, src/discovery/search, src/registry,
 *               src/commands/describe (describeCommand),
 *               src/engine/delivery/spec,
 *               src/engine/objective,
 *               src/output/{envelope,formatter}
 * @feeds        src/cli.ts agent entrypoint; complements `unicli search`
 *               (set semantics) with action semantics ("give me the answer").
 * @breaks       Emits `empty_result` envelope (exit 66) when no adapter
 *               scores above the floor and no objective compiler accepts the
 *               goal. Otherwise always success path — this command does not
 *               perform network calls or writes.
 * @invariants   Never auto-executes. Objective plans keep match=null so a
 *               multi-step state goal cannot masquerade as a one-command hit.
 * @side-effects None — local index lookup only.
 * @perf         O(N) over BM25 index already loaded; <10ms cold per
 *               discovery/search.ts header.
 * @concurrency  Pure; no shared state.
 * @test         tests/unit/commands/do.test.ts
 * @stability    experimental
 * @since        2026-05-18
 */

import { Command, Option } from "commander";
import { search, type SearchResult } from "../discovery/search.js";
import { commandUsesBrowser, getAdapter, resolveCommand } from "../registry.js";
import { describeCommand } from "./describe.js";
import { format, detectFormat } from "../output/formatter.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { buildDeliveryOperatorSpecTemplate } from "../engine/delivery/spec.js";
import {
  buildCommandContract,
  buildCoreCommandContract,
} from "../core/command-contract.js";
import { buildArgumentExample } from "../core/argument-schema.js";
import { getCoreDiscoveryCommand } from "../discovery/core-catalog.js";
import {
  buildObjectiveDoPayload,
  buildObjectiveNextActions,
  compileObjectivePlan,
} from "../engine/objective/index.js";
import type {
  AgentContext,
  AgentNextAction,
  AgentNextActionParam,
} from "../output/envelope.js";
import type { DeliveryOperatorSpec } from "../engine/delivery/spec.js";
import type { CommandOperatorProfile } from "../core/operator-model.js";
import {
  evaluateCommandFeasibility,
  mergeCapabilityRequirements,
  parseIntentCapabilityPlan,
  type CapabilityRequirements,
  type CommandFeasibility,
} from "../discovery/feasibility.js";
import type {
  ExecutionOperator,
  OperationEffect,
  OperatorTargetScope,
  OutputFormat,
  TargetSurface,
} from "../types.js";

const DEFAULT_TOP = 3;
const SCORE_FLOOR = 0.0;

interface DoOpts {
  top: string;
  schema: boolean;
  operator?: ExecutionOperator;
  surface?: TargetSurface;
  scope?: OperatorTargetScope;
  effect?: OperationEffect;
  maxImpact?: "background" | "target-scoped" | "foreground";
  platform?: NodeJS.Platform;
  allowCoordinateActuation?: boolean;
}

interface MatchPayload {
  site: string;
  command: string;
  score: number;
  description: string;
  category: string;
  args_schema?: Record<string, unknown> | string;
  example_stdin?: Record<string, unknown> | string;
  invocation?: string;
  operator?: CommandOperatorProfile;
  feasibility?: CommandFeasibility;
}

export function registerDoCommand(program: Command): void {
  program
    .command("do <intent...>")
    .description(
      "Route a natural-language intent to the best-fit adapter command (plan-only; agent executes the suggested next_action)",
    )
    .option(
      "-n, --top <n>",
      `Return top-N candidates (default ${DEFAULT_TOP})`,
      String(DEFAULT_TOP),
    )
    .option(
      "--no-schema",
      "Omit args_schema and example_stdin from each match payload",
    )
    .addOption(
      new Option(
        "--operator <operator>",
        "require one execution operator",
      ).choices([
        "structured-api",
        "browser-protocol",
        "native-cli",
        "browser-semantic",
        "desktop-accessibility",
        "visual-observation",
        "visual-coordinate",
        "local-runtime",
      ]),
    )
    .addOption(
      new Option("--surface <surface>", "require one target surface").choices([
        "web",
        "desktop",
        "system",
        "mobile",
      ]),
    )
    .addOption(
      new Option(
        "--scope <scope>",
        "require one exact operator target scope",
      ).choices([
        "service",
        "host-process",
        "browser-renderer",
        "native-window",
        "desktop",
        "local-runtime",
      ]),
    )
    .addOption(
      new Option("--effect <effect>", "require one operation effect").choices([
        "read",
        "download_file",
        "send_message",
        "publish_content",
        "account_state",
        "remote_transform",
        "remote_resource",
        "service_state",
        "local_app",
        "local_file",
        "destructive",
        "unknown_write",
      ]),
    )
    .addOption(
      new Option(
        "--max-impact <impact>",
        "reject candidates exceeding this interaction impact",
      ).choices(["background", "target-scoped", "foreground"]),
    )
    .addOption(
      new Option(
        "--platform <platform>",
        "require a statically compatible host platform",
      )
        .choices(["darwin", "win32", "linux"])
        .default(process.platform),
    )
    .option(
      "--allow-coordinate-actuation",
      "authorize visual-coordinate candidates when no coordinate operator is explicitly required",
      false,
    )
    .action((intentParts: string[], opts: DoOpts) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      const intent = intentParts.join(" ").trim();

      let top: number;
      try {
        top = parseTop(opts.top);
      } catch (e) {
        emitInvalidInput(
          startedAt,
          fmt,
          intent,
          e instanceof Error ? e.message : "invalid --top value",
          `Pass a positive integer up to ${TOP_HARD_LIMIT}`,
        );
        return;
      }
      const includeSchema = opts.schema !== false;

      if (!intent) {
        emitEmpty(startedAt, fmt, intent, "missing intent argument");
        return;
      }

      const objectivePlan = compileObjectivePlan(intent);
      const intentPlan = parseIntentCapabilityPlan(intent);
      const requirements = doRequirements(intentPlan.requirements, opts);
      const results = search(intentPlan.task_text, top, { requirements });
      const filtered = results.filter((r) => r.score > SCORE_FLOOR);
      const hardRequirements = hasHardRequirements(requirements);
      const semanticResults = search(
        intentPlan.task_text,
        Math.min(TOP_HARD_LIMIT, Math.max(top * 3, 10)),
      ).filter((result) => result.score > SCORE_FLOOR);

      if (!objectivePlan && filtered.length === 0) {
        if (!hardRequirements || semanticResults.length === 0) {
          emitEmpty(
            startedAt,
            fmt,
            intent,
            "no adapter scored above the floor",
          );
          return;
        }
      }

      const matches = filtered.map((result) =>
        enrichMatch(result, requirements, includeSchema),
      );
      const selectedIds = new Set(
        matches.map((match) => `${match.site}/${match.command}`),
      );
      const blockedMatches = semanticResults
        .filter(
          (result) => !selectedIds.has(`${result.site}/${result.command}`),
        )
        .map((result) => enrichMatch(result, requirements, false))
        .filter(
          (match) =>
            match.feasibility?.compatibility !== "compatible" &&
            matchesRequestedIdentity(match, requirements),
        )
        .slice(0, top);

      if (objectivePlan) {
        const ctx: AgentContext = {
          command: "core.do",
          duration_ms: Date.now() - startedAt,
          surface: "web",
          next_actions: buildObjectiveNextActions(intent, objectivePlan),
        };
        console.log(
          format(
            buildObjectiveDoPayload(intent, objectivePlan, matches),
            undefined,
            fmt,
            ctx,
          ),
        );
        return;
      }

      const best = hardRequirements
        ? matches.find(
            (match) => match.feasibility?.compatibility === "compatible",
          )
        : matches[0];
      if (!best) {
        emitRouteUnavailable(
          startedAt,
          fmt,
          intent,
          requirements,
          blockedMatches,
        );
        return;
      }
      const data: Record<string, unknown> = {
        intent,
        match: {
          site: best.site,
          command: best.command,
          score: best.score,
          category: best.category,
          description: best.description,
          invocation: commandInvocation(best),
          ...(best.operator ? { operator: best.operator } : {}),
        },
        candidates: matches,
        blocked_candidates: blockedMatches,
        routing_policy: {
          selection:
            "BM25/intent ranking intersected with operation, operator, target, effect, platform, and interaction constraints before top-k selection",
          requirements,
          provider_recovery:
            "provider failures require repair or explicit replanning; execution does not cross operators",
        },
      };
      const deliverySpecTemplate = deliverySpecTemplateForMatch(intent, best);
      if (deliverySpecTemplate) {
        data.delivery_spec_template = deliverySpecTemplate;
      }

      const ctx: AgentContext = {
        command: "core.do",
        duration_ms: Date.now() - startedAt,
        surface: "web",
        next_actions: successNextActions(
          intent,
          best,
          matches,
          Boolean(deliverySpecTemplate),
        ),
      };
      const outputData =
        fmt === "md"
          ? markdownDoProjection(
              intent,
              best,
              matches,
              blockedMatches,
              requirements,
            )
          : data;
      console.log(format(outputData, undefined, fmt, ctx));
    });
}

function markdownDoProjection(
  intent: string,
  best: MatchPayload | undefined,
  matches: MatchPayload[],
  blockedMatches: MatchPayload[],
  requirements: CapabilityRequirements,
): Record<string, unknown> {
  if (!best) {
    return {
      intent,
      selected_command: null,
      requirements,
      blocked_candidates: blockedMatches.map((match) => ({
        command: `${match.site} ${match.command}`,
        operator: match.operator?.operator ?? "unknown",
        operation_family:
          match.feasibility?.contract?.operation_family ?? "unknown",
        compatibility: match.feasibility?.compatibility ?? "unknown",
        rejected_by: match.feasibility?.rejected_by ?? [],
        uncertain_by: match.feasibility?.uncertain_by ?? [],
      })),
    };
  }
  return {
    intent,
    selected_command: `${best.site} ${best.command}`,
    invocation: commandInvocation(best),
    description: best.description,
    score: best.score,
    operator: best.operator?.operator ?? "unknown",
    operation_family: best.feasibility?.contract?.operation_family ?? "unknown",
    operator_source: best.operator?.operator_source ?? "unknown",
    operator_confidence: best.operator?.operator_confidence ?? "unknown",
    provider: best.operator?.provider ?? "unknown",
    target_scope: best.operator?.target_scope ?? "unknown",
    interaction_impact: best.operator?.interaction_impact ?? "unknown",
    contract_compatibility: best.feasibility?.compatibility ?? "unknown",
    runtime_readiness: "not_evaluated",
    selection_reason: best.operator?.selection_reason ?? "no operator profile",
    requirements,
    repair_command: `unicli describe ${best.site} ${best.command}`,
    alternatives: matches
      .slice(1)
      .map(
        (match) =>
          `${match.site} ${match.command} (${match.score}, ${match.operator?.operator ?? "unknown"})`,
      ),
  };
}

function doRequirements(
  inferred: CapabilityRequirements,
  opts: DoOpts,
): CapabilityRequirements {
  const explicit: CapabilityRequirements = {
    operator: opts.operator,
    target_surface: opts.surface,
    target_scope: opts.scope,
    effect: opts.effect,
    max_interaction_impact: opts.maxImpact,
    platform: opts.platform,
    allow_coordinate_actuation:
      opts.allowCoordinateActuation === true ||
      opts.operator === "visual-coordinate",
  };
  const merged = mergeCapabilityRequirements(inferred, explicit);
  return merged;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const TOP_HARD_LIMIT = 25;

function enrichMatch(
  result: SearchResult,
  requirements: CapabilityRequirements,
  includeSchema: boolean,
): MatchPayload {
  const match: MatchPayload = {
    site: result.site,
    command: result.command,
    score: round(result.score, 4),
    description: result.description,
    category: result.category,
  };
  const resolved = resolveCommand(result.site, result.command);
  if (resolved) {
    match.operator = buildCommandContract({
      adapter: resolved.adapter,
      commandName: result.command,
      command: resolved.command,
    }).execution;
    if (includeSchema) {
      const adapter = getAdapter(result.site);
      const description = describeCommand(
        result.site,
        result.command,
        resolved.command,
        adapter,
      );
      const argsSchema = description.args_schema as
        | Record<string, unknown>
        | string
        | undefined;
      const example = description.example_stdin as
        | Record<string, unknown>
        | string
        | undefined;
      const channels = description.channels as
        | Record<string, unknown>
        | undefined;
      if (argsSchema !== undefined) match.args_schema = argsSchema;
      if (example !== undefined) match.example_stdin = example;
      if (typeof channels?.shell === "string") {
        match.invocation = channels.shell;
      }
    }
  }
  if (!match.operator) {
    const coreCommand = getCoreDiscoveryCommand(result.site, result.command);
    if (coreCommand) {
      const contract = buildCoreCommandContract({
        command: coreCommand,
      });
      match.operator = contract.execution;
      match.invocation =
        coreCommand.channels?.shell ??
        `unicli ${coreCommand.site} ${coreCommand.command}`;
      if (includeSchema) {
        match.args_schema = { ...contract.schemas.input };
        match.example_stdin = buildArgumentExample(coreCommand.args ?? []);
      }
    }
  }
  match.feasibility = evaluateCommandFeasibility(
    result.site,
    result.command,
    requirements,
  );
  return match;
}

function hasHardRequirements(requirements: CapabilityRequirements): boolean {
  return (
    (requirements.required_sites?.length ?? 0) > 0 ||
    requirements.operation_family !== undefined ||
    requirements.operator !== undefined ||
    requirements.target_surface !== undefined ||
    requirements.target_scope !== undefined ||
    requirements.effect !== undefined ||
    requirements.allow_browser === false ||
    (requirements.forbidden_operators?.length ?? 0) > 0
  );
}

function matchesRequestedIdentity(
  match: MatchPayload,
  requirements: CapabilityRequirements,
): boolean {
  const profile = match.feasibility?.contract;
  return (
    (!requirements.required_sites ||
      requirements.required_sites.includes(match.site)) &&
    (!requirements.operation_family ||
      profile?.operation_family === requirements.operation_family)
  );
}

function blockedNextActions(blockedMatches: MatchPayload[]): AgentNextAction[] {
  const blocked = blockedMatches[0];
  if (!blocked) return [];
  return [
    {
      command: `unicli describe ${blocked.site} ${blocked.command}`,
      description:
        "Inspect the closest semantic command and its incompatible operator contract",
    },
    {
      command: `unicli search "${blocked.site} ${blocked.command}"`,
      description:
        "Replan explicitly by relaxing either the provider or substrate constraint",
    },
  ];
}

/**
 * Parse `--top`. Throws on invalid input — caller converts to an
 * `invalid_input` envelope. Bad CLI input is a caller bug, not a system
 * state to silently snap to a default (rule 02).
 */
function parseTop(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--top must be a positive integer (got "${raw}")`);
  }
  if (n > TOP_HARD_LIMIT) {
    throw new Error(`--top ${n} exceeds hard limit ${TOP_HARD_LIMIT}`);
  }
  return n;
}

function round(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function commandInvocation(match: MatchPayload): string {
  return match.invocation ?? `unicli ${match.site} ${match.command}`;
}

function stdinJsonInvocation(match: MatchPayload): string {
  const payload = JSON.stringify(recordValue(match.example_stdin) ?? {});
  const quoted = payload.replaceAll("'", "'\\''");
  return `printf '%s\\n' '${quoted}' | unicli ${match.site} ${match.command}`;
}

function successNextActions(
  intent: string,
  best: MatchPayload,
  matches: MatchPayload[],
  hasDeliverySpecTemplate: boolean,
): AgentNextAction[] {
  const actions: AgentNextAction[] = [];

  if (hasDeliverySpecTemplate) {
    actions.push({
      command: "unicli delivery run <delivery-spec.json>",
      description:
        "Execute the included delivery_spec_template before claiming success",
    });
  }

  // Direct command remains available when the caller intentionally bypasses
  // delivery evidence collection for an inspect-only or manually supervised run.
  const params = argsSchemaToParams(best.args_schema);
  actions.push({
    command: commandInvocation(best),
    description: `Invoke the top-scored match (${best.score})`,
    ...(params ? { params } : {}),
  });

  // Schema introspection
  actions.push({
    command: `unicli describe ${best.site} ${best.command}`,
    description: "Read the full schema, channels, and example payload",
  });

  // Stdin-JSON channel for payloads with quoting hazards
  if (!best.invocation) {
    actions.push({
      command: stdinJsonInvocation(best),
      description:
        "Stdin-JSON channel — use when params contain quotes/emoji/JSON",
    });
  }

  // Surface a runner-up if it scored close to the top
  if (
    matches.length > 1 &&
    matches[1] &&
    matches[1].score >= best.score * 0.7
  ) {
    const runner = matches[1];
    actions.push({
      command: commandInvocation(runner),
      description: `Runner-up (score ${runner.score}) — consider if top match misreads intent`,
    });
  }

  // Broaden if the agent wants the full ranked list
  actions.push({
    command: `unicli search "${intent}"`,
    description: "List all matching candidates with scores",
  });

  return actions;
}

function deliverySpecTemplateForMatch(
  intent: string,
  best: MatchPayload,
): DeliveryOperatorSpec | undefined {
  const resolved = resolveCommand(best.site, best.command);
  if (!resolved) return undefined;
  const adapterPath = resolved.command.adapter_path;
  return buildDeliveryOperatorSpecTemplate({
    intent,
    site: best.site,
    command: best.command,
    description: best.description,
    args: recordValue(best.example_stdin),
    adapter_path: adapterPath,
    adapter_type: resolved.adapter.type,
    target_surface: resolved.command.target_surface,
    uses_browser: commandUsesBrowser(resolved.adapter, resolved.command),
  });
}

function recordValue(
  value: Record<string, unknown> | string | undefined,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

/**
 * Walk a JSON-schema args object and produce AgentNextActionParam hints —
 * we surface the description and the closed-set `enum` when present so the
 * agent fills the template without re-reading docs.
 */
function argsSchemaToParams(
  schema: Record<string, unknown> | string | undefined,
): Record<string, AgentNextActionParam> | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema === "string") return undefined;
  const properties =
    (schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined) ?? undefined;
  if (!properties) return undefined;
  const out: Record<string, AgentNextActionParam> = {};
  for (const [name, prop] of Object.entries(properties)) {
    const param: AgentNextActionParam = {};
    if (typeof prop.description === "string") {
      param.description = prop.description;
    }
    if (
      Array.isArray(prop.enum) &&
      prop.enum.every((v) => typeof v === "string" || typeof v === "number")
    ) {
      param.enum = prop.enum as Array<string | number>;
    }
    if (
      prop.default !== undefined &&
      (typeof prop.default === "string" ||
        typeof prop.default === "number" ||
        typeof prop.default === "boolean")
    ) {
      param.default = prop.default;
    }
    if (Object.keys(param).length > 0) {
      out[name] = param;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function emitEmpty(
  startedAt: number,
  fmt: OutputFormat,
  intent: string,
  reason: string,
): void {
  const ctx: AgentContext = {
    command: "core.do",
    duration_ms: Date.now() - startedAt,
    surface: "web",
    next_actions: [
      {
        command: `unicli search "${intent || "<query>"}"`,
        description: "Broaden the query — list all candidates with scores",
      },
      {
        command: `unicli describe`,
        description: "Browse the site index for the right vertical",
      },
    ],
    error: {
      code: "empty_result",
      message: `No adapter matched intent: ${reason}`,
      retryable: false,
      suggestion:
        "Use simpler keywords or run `unicli describe` to see the full catalogue",
    },
  };
  printErrorEnvelope({ fmt, exitCode: 66, ctx });
}

function emitRouteUnavailable(
  startedAt: number,
  fmt: OutputFormat,
  intent: string,
  requirements: CapabilityRequirements,
  blockedMatches: MatchPayload[],
): void {
  const blockedCandidates = blockedMatches.map((match) => ({
    site: match.site,
    command: match.command,
    score: match.score,
    operator: match.operator?.operator ?? "unknown",
    operation_family:
      match.feasibility?.contract?.operation_family ?? "unknown",
    effect: match.feasibility?.contract?.effect ?? "unknown_write",
    rejected_by: match.feasibility?.rejected_by ?? [],
    uncertain_by: match.feasibility?.uncertain_by ?? [],
  }));
  const ctx: AgentContext = {
    command: "core.do",
    duration_ms: Date.now() - startedAt,
    surface: "web",
    next_actions: blockedNextActions(blockedMatches),
    error: {
      code: "route_unavailable",
      message:
        "No command satisfies the requested site, operation, and execution constraints.",
      retryable: false,
      suggestion:
        "Inspect the blocked candidate contract, repair that capability, or explicitly replan one constraint.",
      alternatives: blockedMatches.map(
        (match) => `unicli describe ${match.site} ${match.command}`,
      ),
      details: {
        intent,
        requirements,
        blocked_candidates: blockedCandidates,
      },
    },
  };
  printErrorEnvelope({ fmt, exitCode: 66, ctx });
}

function emitInvalidInput(
  startedAt: number,
  fmt: OutputFormat,
  intent: string,
  message: string,
  suggestion: string,
): void {
  const ctx: AgentContext = {
    command: "core.do",
    duration_ms: Date.now() - startedAt,
    surface: "web",
    next_actions: [
      {
        command: `unicli search "${intent || "<query>"}"`,
        description: "List all candidates without --top constraints",
      },
    ],
    error: {
      code: "invalid_input",
      message,
      retryable: false,
      suggestion,
    },
  };
  printErrorEnvelope({ fmt, exitCode: 2, ctx });
}
