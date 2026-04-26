/**
 * `unicli migrate` — migration helpers.
 *
 * Currently ships one subcommand:
 *
 *   unicli import legacy-yaml <path>
 *       Read a legacy YAML adapter, emit the Uni-CLI v2 equivalent on
 *       stdout (or `-o <out>`). Deterministic field mapping; unknown
 *       fields warn to stderr and are preserved under `_legacy_extra`
 *       for manual review.
 *
 * Design notes:
 *   - Parsing and emitting use the same js-yaml we use everywhere else.
 *   - Core field mappings are table-driven (LEGACY_FIELD_MAP) so new
 *     field names can be added without touching the migration logic.
 *   - The migration is deterministic and pure: same input -> same output
 *     byte-for-byte (modulo yaml dump defaults).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import yaml from "js-yaml";
import chalk from "chalk";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";
import { ExitCode } from "../types.js";

/** Known legacy top-level fields and how they map to Uni-CLI fields. */
export const LEGACY_FIELD_MAP: Record<string, string> = {
  site: "site",
  name: "name",
  description: "description",
  summary: "description",
  type: "type",
  auth: "strategy",
  authentication: "strategy",
  pipeline: "pipeline",
  steps: "pipeline",
  columns: "columns",
  output_columns: "columns",
  args: "args",
  arguments: "args",
  parameters: "args",
  rate_limit: "rate_limit",
  throttle: "rate_limit",
};

/** Legacy auth values -> Uni-CLI strategy values. */
const AUTH_MAP: Record<string, string> = {
  none: "public",
  public: "public",
  anonymous: "public",
  cookie: "cookie",
  cookies: "cookie",
  csrf: "header",
  csrf_token: "header",
  header: "header",
  bearer: "header",
  xhr: "intercept",
  intercept: "intercept",
  ui: "ui",
  browser_ui: "ui",
};

/** Legacy pipeline step names that rename to Uni-CLI equivalents. */
const STEP_RENAME: Record<string, string> = {
  http: "fetch",
  request: "fetch",
  get: "fetch",
  post: "fetch",
  xpath: "select",
  jsonpath: "select",
  extract: "map",
  transform: "map",
  keep: "filter",
  drop: "filter",
  slice: "limit",
  take: "limit",
  run: "exec",
  shell: "exec",
  open: "navigate",
  visit: "navigate",
  goto: "navigate",
  watch: "intercept",
  capture: "intercept",
  snapshot_dom: "snapshot",
  accessibility_tree: "snapshot",
};

interface LegacyAdapterShape {
  [key: string]: unknown;
}

interface UniCliShape {
  site?: unknown;
  name?: unknown;
  description?: unknown;
  type?: unknown;
  transport?: string;
  strategy?: string;
  capabilities?: string[];
  minimum_capability?: string;
  trust?: string;
  confidentiality?: string;
  quarantine?: boolean;
  pipeline?: unknown[];
  columns?: unknown;
  args?: unknown;
  rate_limit?: unknown;
  _legacy_extra?: Record<string, unknown>;
}

export interface MigrateReport {
  output: UniCliShape;
  warnings: string[];
  renamed_steps: string[];
  dropped_fields: string[];
}

function mapAuth(value: unknown): string {
  if (typeof value !== "string") return "public";
  return AUTH_MAP[value.toLowerCase()] ?? "public";
}

function strategyToTransport(strategy: string): string {
  switch (strategy) {
    case "intercept":
    case "ui":
      return "cdp-browser";
    case "public":
    case "cookie":
    case "header":
    default:
      return "http";
  }
}

function renameStepsInPipeline(
  steps: unknown,
  renamed: string[],
): unknown[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  return steps.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return step;
    const entries = Object.entries(step as Record<string, unknown>);
    if (entries.length === 0) return step;
    const [oldName, body] = entries[0];
    const newName = STEP_RENAME[oldName];
    if (newName && newName !== oldName) {
      renamed.push(`${oldName} -> ${newName}`);
      return { [newName]: body, ...Object.fromEntries(entries.slice(1)) };
    }
    return step;
  });
}

function inferCapabilities(pipeline: unknown[] | undefined): string[] {
  if (!pipeline) return [];
  const caps = new Set<string>();
  for (const step of pipeline) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const keys = Object.keys(step as Record<string, unknown>);
    if (keys.length > 0) caps.add(keys[0]);
  }
  return Array.from(caps);
}

function minimumCapabilityFor(transport: string, caps: string[]): string {
  if (transport === "cdp-browser") {
    if (caps.includes("intercept")) return "cdp-browser.intercept";
    if (caps.includes("navigate")) return "cdp-browser.navigate";
    return "cdp-browser.snapshot";
  }
  if (transport === "subprocess") return "subprocess.exec";
  // default http
  return "http.fetch";
}

export function migrateLegacyYaml(source: LegacyAdapterShape): MigrateReport {
  const warnings: string[] = [];
  const renamed: string[] = [];
  const dropped: string[] = [];
  const out: UniCliShape = {};

  for (const [key, value] of Object.entries(source)) {
    const mapped = LEGACY_FIELD_MAP[key];
    if (!mapped) {
      dropped.push(key);
      continue;
    }
    if (mapped === "strategy") {
      out.strategy = mapAuth(value);
    } else {
      (out as Record<string, unknown>)[mapped] = value;
    }
  }

  if (!out.strategy) out.strategy = "public";
  out.transport = strategyToTransport(out.strategy);

  if (out.pipeline) {
    out.pipeline = renameStepsInPipeline(out.pipeline, renamed);
  }

  const caps = inferCapabilities(out.pipeline as unknown[] | undefined);
  out.capabilities = caps;
  out.minimum_capability = minimumCapabilityFor(out.transport, caps);

  // Schema-v2 metadata defaults — confidentiality tracks strategy.
  out.trust = "public";
  out.confidentiality = out.strategy === "public" ? "public" : "internal";
  out.quarantine = false;

  if (dropped.length > 0) {
    warnings.push(
      `Dropped unknown legacy fields: ${dropped.join(", ")} (preserved under _legacy_extra)`,
    );
    const extras: Record<string, unknown> = {};
    for (const key of dropped) {
      extras[key] = source[key];
    }
    out._legacy_extra = extras;
  }

  if (renamed.length > 0) {
    warnings.push(`Renamed pipeline steps: ${renamed.join(", ")}`);
  }

  return {
    output: out,
    warnings,
    renamed_steps: renamed,
    dropped_fields: dropped,
  };
}

/** Emit YAML with stable key order for reproducibility. */
export function emitUnicliYaml(shape: UniCliShape): string {
  const ordered: Record<string, unknown> = {};
  const ORDER = [
    "site",
    "name",
    "description",
    "type",
    "transport",
    "strategy",
    "capabilities",
    "minimum_capability",
    "trust",
    "confidentiality",
    "quarantine",
    "args",
    "pipeline",
    "columns",
    "rate_limit",
    "_legacy_extra",
  ] as const;
  for (const key of ORDER) {
    const v = (shape as Record<string, unknown>)[key];
    if (v !== undefined) ordered[key] = v;
  }
  for (const key of Object.keys(shape)) {
    if (!(key in ordered)) {
      ordered[key] = (shape as Record<string, unknown>)[key];
    }
  }
  return yaml.dump(ordered, { lineWidth: 100, noRefs: true });
}

export function registerMigrateCommand(program: Command): void {
  const imp = program
    .command("import")
    .description("Import adapters from other formats");

  imp
    .command("legacy-yaml <path>")
    .description("Convert a legacy YAML adapter to the Uni-CLI v2 format")
    .option("-o, --output <path>", "Write result to file (default: stdout)")
    .option("--json-report", "Also emit a JSON migration report to stderr")
    .action(
      (path: string, opts: { output?: string; jsonReport?: boolean }): void => {
        const startedAt = Date.now();
        const ctx = makeCtx("migrate.legacy", startedAt);
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );

        let source: LegacyAdapterShape;
        try {
          const text = readFileSync(path, "utf-8");
          const parsed = yaml.load(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(
              "input is not a YAML mapping (must be an object at the root)",
            );
          }
          source = parsed as LegacyAdapterShape;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.error = {
            code: "invalid_input",
            message: `cannot read ${path}: ${msg}`,
            suggestion: "Supply a valid legacy YAML mapping file.",
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(ExitCode.USAGE_ERROR);
        }

        const report = migrateLegacyYaml(source);

        for (const w of report.warnings) {
          process.stderr.write(chalk.yellow(`  [migrate] warning: ${w}\n`));
        }

        const out = emitUnicliYaml(report.output);
        if (opts.output) {
          writeFileSync(opts.output, out, "utf-8");
        }

        const data = {
          input_path: path,
          output_path: opts.output ?? null,
          yaml: out,
          warnings: report.warnings,
          renamed_steps: report.renamed_steps,
          dropped_fields: report.dropped_fields,
        };

        ctx.duration_ms = Date.now() - startedAt;
        console.log(format(data, undefined, fmt, ctx));

        if (opts.output) {
          console.error(chalk.green(`  [migrate] wrote ${opts.output}`));
        }

        if (opts.jsonReport) {
          // Preserve legacy --json-report side channel (supplementary report on
          // stderr) — the v2 envelope on stdout is the primary surface.
          process.stderr.write(
            JSON.stringify(
              {
                warnings: report.warnings,
                renamed_steps: report.renamed_steps,
                dropped_fields: report.dropped_fields,
              },
              null,
              2,
            ) + "\n",
          );
        }
      },
    );
}
