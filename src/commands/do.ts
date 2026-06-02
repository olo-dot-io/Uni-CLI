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

import { Command } from "commander";
import { search } from "../discovery/search.js";
import { commandUsesBrowser, getAdapter, resolveCommand } from "../registry.js";
import { describeCommand } from "./describe.js";
import { format, detectFormat } from "../output/formatter.js";
import { printErrorEnvelope } from "../output/error-writer.js";
import { buildDeliveryOperatorSpecTemplate } from "../engine/delivery/spec.js";
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
import type { OutputFormat } from "../types.js";

const DEFAULT_TOP = 3;
const SCORE_FLOOR = 0.0;

interface DoOpts {
  top: string;
  schema: boolean;
}

interface MatchPayload {
  site: string;
  command: string;
  score: number;
  description: string;
  category: string;
  args_schema?: Record<string, unknown> | string;
  example_stdin?: Record<string, unknown> | string;
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
      const results = search(intent, top);
      const filtered = results.filter((r) => r.score > SCORE_FLOOR);

      if (!objectivePlan && filtered.length === 0) {
        emitEmpty(startedAt, fmt, intent, "no adapter scored above the floor");
        return;
      }

      const matches: MatchPayload[] = filtered.map((r) => {
        const m: MatchPayload = {
          site: r.site,
          command: r.command,
          score: round(r.score, 4),
          description: r.description,
          category: r.category,
        };
        if (includeSchema) {
          const resolved = resolveCommand(r.site, r.command);
          if (resolved) {
            const adapter = getAdapter(r.site);
            const desc = describeCommand(
              r.site,
              r.command,
              resolved.command,
              adapter,
            );
            const argsSchema = desc.args_schema as
              | Record<string, unknown>
              | string
              | undefined;
            const example = desc.example_stdin as
              | Record<string, unknown>
              | string
              | undefined;
            if (argsSchema !== undefined) m.args_schema = argsSchema;
            if (example !== undefined) m.example_stdin = example;
          }
        }
        return m;
      });

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

      const best = matches[0];
      const data: Record<string, unknown> = {
        intent,
        match: best
          ? {
              site: best.site,
              command: best.command,
              score: best.score,
              category: best.category,
              description: best.description,
              invocation: `unicli ${best.site} ${best.command}`,
            }
          : null,
        candidates: matches,
      };
      const deliverySpecTemplate = best
        ? deliverySpecTemplateForMatch(intent, best)
        : undefined;
      if (deliverySpecTemplate) {
        data.delivery_spec_template = deliverySpecTemplate;
      }

      const ctx: AgentContext = {
        command: "core.do",
        duration_ms: Date.now() - startedAt,
        surface: "web",
        next_actions: best
          ? successNextActions(
              intent,
              best,
              matches,
              Boolean(deliverySpecTemplate),
            )
          : [],
      };
      console.log(format(data, undefined, fmt, ctx));
    });
}

// ── helpers ──────────────────────────────────────────────────────────────────

const TOP_HARD_LIMIT = 25;

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
    command: `unicli ${best.site} ${best.command}`,
    description: `Invoke the top-scored match (${best.score})`,
    ...(params ? { params } : {}),
  });

  // Schema introspection
  actions.push({
    command: `unicli describe ${best.site} ${best.command}`,
    description: "Read the full schema, channels, and example payload",
  });

  // Stdin-JSON channel for payloads with quoting hazards
  actions.push({
    command: `echo '{}' | unicli ${best.site} ${best.command}`,
    description:
      "Stdin-JSON channel — use when params contain quotes/emoji/JSON",
  });

  // Surface a runner-up if it scored close to the top
  if (
    matches.length > 1 &&
    matches[1] &&
    matches[1].score >= best.score * 0.7
  ) {
    const runner = matches[1];
    actions.push({
      command: `unicli ${runner.site} ${runner.command}`,
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
