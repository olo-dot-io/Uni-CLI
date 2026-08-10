/**
 * @owner       src::output::describe
 * @does        Projects verbose command contracts into an invocation-complete summary and renders the same describe payload for human and compact Agent consumption.
 * @needs       describe payload fields and AgentEnvelope construction
 * @feeds       `unicli describe`
 * @breaks      Missing schema, invocation, effect, or repair fields forces agents back into multi-call discovery.
 * @invariants  Summary mode retains every field required to choose, invoke, and recover a command; full mode remains available at the command boundary.
 * @side-effects None.
 * @perf        O(payload size).
 * @concurrency Pure and reentrant.
 * @test        tests/unit/commands/describe.test.ts
 * @stability   public
 * @since       2026-07-31
 */

import {
  makeEnvelope,
  makeError,
  type AgentContext,
  type AgentError,
} from "./envelope.js";
import { format } from "./formatter.js";
import type { OutputFormat } from "../types.js";

type JsonObject = Record<string, unknown>;

const COMMAND_SUMMARY_KEYS = [
  "command",
  "description",
  "quarantined",
  "strategy",
  "auth",
  "auth_optional",
  "auth_setup",
  "personalization",
  "browser",
  "target_surface",
  "source_path",
  "adapter_path",
  "args_schema",
  "example_stdin",
  "output_schema",
  "channels",
  "next_actions",
] as const;

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Keep the executable command surface while removing duplicated governance and
 * audit detail. `--full` returns the original payload without projection.
 */
export function summarizeDescribePayload(payload: JsonObject): JsonObject {
  if (typeof payload.command !== "string") return payload;

  const contract = objectValue(payload.contract);
  const execution = objectValue(contract?.execution);
  const operation = objectValue(contract?.operation);
  const effect = objectValue(contract?.effect);
  const repair = objectValue(contract?.repair);
  const operationPolicy = objectValue(payload.operation_policy);
  const summary: JsonObject = {};

  for (const key of COMMAND_SUMMARY_KEYS) {
    if (payload[key] !== undefined) summary[key] = payload[key];
  }

  summary.operator = execution?.operator ?? "unknown";
  summary.operation_family = operation?.family ?? "unknown";
  summary.effect =
    effect?.operation_effect ?? operationPolicy?.effect ?? "unknown";
  summary.idempotency = effect?.idempotency ?? "unknown";
  summary.interaction_impact = execution?.interaction_impact ?? "unknown";
  if (repair?.minimum_capability !== undefined) {
    summary.minimum_capability = repair.minimum_capability;
  }
  summary.contract_ref = {
    schema_version: contract?.schema_version ?? "command-contract.v1",
    full_command: `unicli describe ${String(payload.command).replace(/^unicli\s+/, "")} --full`,
  };
  return summary;
}

function inline(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function code(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "\\`")
    .trim();
}

function renderCommand(payload: JsonObject): string[] {
  const lines = [`# ${inline(payload.command)}`, ""];
  if (payload.description) lines.push(inline(payload.description), "");

  lines.push("## Execution", "");
  for (const key of [
    "operator",
    "operation_family",
    "effect",
    "idempotency",
    "interaction_impact",
    "strategy",
    "auth",
    "auth_optional",
    "auth_setup",
    "personalization",
    "browser",
    "target_surface",
    "minimum_capability",
  ]) {
    if (payload[key] !== undefined)
      lines.push(`- **${key}**: ${inline(payload[key])}`);
  }

  const schema = objectValue(payload.args_schema);
  const properties = objectValue(schema?.properties) ?? {};
  const required = new Set(
    Array.isArray(schema?.required) ? schema.required.map(String) : [],
  );
  lines.push("", "## Arguments", "");
  if (Object.keys(properties).length === 0) {
    lines.push("No command arguments.");
  } else {
    lines.push(
      "| Name | Type | Required | Default | Description |",
      "|---|---|---:|---|---|",
    );
    for (const [name, rawSpec] of Object.entries(properties)) {
      const spec = objectValue(rawSpec) ?? {};
      const type = Array.isArray(spec.type)
        ? spec.type.join(" or ")
        : spec.type;
      lines.push(
        `| ${inline(name)} | ${inline(type)} | ${required.has(name) ? "yes" : "no"} | ${spec.default === undefined ? "" : inline(spec.default)} | ${inline(spec.description)} |`,
      );
    }
  }

  const channels = objectValue(payload.channels);
  if (channels) {
    lines.push("", "## Invocation", "");
    for (const [name, command] of Object.entries(channels)) {
      lines.push(`- **${inline(name)}**: \`${code(command)}\``);
    }
  }

  if (payload.example_stdin !== undefined) {
    lines.push(
      "",
      "## Example input",
      "",
      "```json",
      json(payload.example_stdin),
      "```",
    );
  }
  if (payload.output_schema !== undefined) {
    lines.push(
      "",
      "## Output schema",
      "",
      "```json",
      json(payload.output_schema),
      "```",
    );
  }

  if (Array.isArray(payload.next_actions)) {
    lines.push("", "## Next actions", "");
    for (const rawAction of payload.next_actions) {
      const action = objectValue(rawAction) ?? {};
      lines.push(
        `- \`${code(action.command)}\` — ${inline(action.description)}`,
      );
    }
  }

  const renderedKeys = new Set<string>([
    ...COMMAND_SUMMARY_KEYS,
    "operator",
    "operation_family",
    "effect",
    "idempotency",
    "interaction_impact",
    "minimum_capability",
  ]);
  const additional = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !renderedKeys.has(key)),
  );
  if (Object.keys(additional).length > 0) {
    lines.push(
      "",
      "## Additional contract data",
      "",
      "```json",
      json(additional),
      "```",
    );
  }
  return lines;
}

function renderCollection(payload: JsonObject): string[] {
  const rows = Array.isArray(payload.sites)
    ? payload.sites
    : Array.isArray(payload.commands)
      ? payload.commands
      : undefined;
  if (!rows) return ["```json", json(payload), "```"];

  const title =
    typeof payload.site === "string"
      ? `# ${inline(payload.site)}`
      : "# Uni-CLI sites";
  const lines = [title, ""];
  if (Array.isArray(payload.sites)) {
    lines.push(
      "| Site | Type | Strategy | Commands | Personalized | Description |",
      "|---|---|---|---:|---:|---|",
    );
    for (const rawRow of rows) {
      const row = objectValue(rawRow) ?? {};
      lines.push(
        `| ${inline(row.name)} | ${inline(row.type)} | ${inline(row.strategy)} | ${inline(row.commands_count)} | ${inline(row.personalized_commands_count)} | ${inline(row.description)} |`,
      );
    }
  } else {
    if (Array.isArray(payload.personalization_families)) {
      lines.push(
        `Personalized command families  ${payload.personalization_families.map(inline).join(", ") || "none"}`,
        "",
      );
    }
    lines.push(
      "| Command | Personalized | Strategy | Auth | Browser | Arguments | Inspect | Description |",
      "|---|---|---|---:|---:|---|---|---|",
    );
    for (const rawRow of rows) {
      const row = objectValue(rawRow) ?? {};
      const args = Array.isArray(row.args)
        ? row.args
            .map((arg) => {
              const spec = objectValue(arg) ?? {};
              return `${String(spec.name ?? "")}${spec.required ? "*" : ""}`;
            })
            .join(", ")
        : "";
      lines.push(
        `| ${inline(row.name)} | ${inline(row.personalization)} | ${inline(row.strategy)} | ${inline(row.auth)} | ${inline(row.browser)} | ${inline(args)} | ${inline(row.inspect)} | ${inline(row.description)} |`,
      );
    }
  }
  return lines;
}

/** Human renderer whose content is derived from the exact structured payload. */
export function renderDescribeMarkdown(
  payload: JsonObject,
  ctx: AgentContext,
): string {
  const lines = [
    "---",
    "ok: true",
    'schema_version: "2"',
    `command: ${ctx.command}`,
    `duration_ms: ${ctx.duration_ms}`,
    `surface: ${ctx.surface ?? "web"}`,
    "---",
    "",
    ...(typeof payload.command === "string"
      ? renderCommand(payload)
      : renderCollection(payload)),
  ];
  return `${lines.join("\n")}\n`;
}

/** Compact describe is minified envelope JSON, never a lossy `[object Object]` row. */
export function renderDescribeCompact(
  payload: JsonObject,
  ctx: AgentContext,
): string {
  return JSON.stringify(makeEnvelope(ctx, payload));
}

/** One renderer shared by the manifest fast path and full Commander path. */
export function formatDescribePayload(
  payload: JsonObject,
  fmt: OutputFormat,
  ctx: AgentContext,
): string {
  if (fmt === "md" || fmt === "table") {
    return renderDescribeMarkdown(payload, ctx);
  }
  if (fmt === "compact") return renderDescribeCompact(payload, ctx);
  if (fmt === "csv") {
    const row = Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : value,
      ]),
    );
    return format([row], Object.keys(row), fmt, ctx);
  }
  return format(payload, undefined, fmt, ctx);
}

/** Error rendering stays non-empty even for compact and CSV describe views. */
export function formatDescribeError(
  error: AgentError,
  fmt: OutputFormat,
  ctx: AgentContext,
): string {
  if (fmt === "compact") return JSON.stringify(makeError(ctx, error));
  if (fmt === "csv") {
    return format(
      [
        {
          code: error.code,
          message: error.message,
          suggestion: error.suggestion ?? "",
          alternatives: (error.alternatives ?? []).join(" | "),
        },
      ],
      ["code", "message", "suggestion", "alternatives"],
      fmt,
      ctx,
    );
  }
  return format(null, undefined, fmt, { ...ctx, error });
}

/** Rank typo suggestions deterministically without loading the search index. */
export function nearestDescribeNames(
  input: string,
  candidates: readonly string[],
): string[] {
  const normalized = input.toLowerCase();
  const maximumDistance = Math.max(2, Math.floor(normalized.length * 0.4));
  return [...new Set(candidates)]
    .map((name) => ({
      name,
      distance: editDistance(normalized, name),
      prefix:
        name.toLowerCase().startsWith(normalized) ||
        normalized.startsWith(name.toLowerCase()),
    }))
    .filter(
      (candidate) => candidate.prefix || candidate.distance <= maximumDistance,
    )
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) ||
        a.distance - b.distance ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 3)
    .map((candidate) => candidate.name);
}

/** Levenshtein distance with O(min(a,b)) memory for bounded typo recovery. */
function editDistance(a: string, b: string): number {
  let left = [...a.toLowerCase()];
  let right = [...b.toLowerCase()];
  if (left.length > right.length) [left, right] = [right, left];
  let previous = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let row = 1; row <= right.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= left.length; column += 1) {
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) +
          (left[column - 1] === right[row - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[left.length] ?? right.length;
}
