/**
 * `unicli migrate schema-v2 [--dry-run] [path]` — mass-migrate legacy v1 YAML
 * adapters to schema v2 by injecting the five new required metadata fields
 * with inferred defaults.
 *
 * Five injected fields (from {@link migrateToV2} semantics):
 *   - capabilities       — inferred from pipeline step names
 *   - minimum_capability — the most-privileged step in the pipeline
 *   - trust              — "public" unless adapter mutates host (desktop / exec)
 *   - confidentiality    — "public" unless dir/file matches a private pattern
 *   - quarantine         — preserved if already set, else false
 *
 * The migrator appends the five fields as raw YAML at the end of each file
 * to preserve comments, quoting style, and existing whitespace. Files
 * already carrying all five v2 fields are skipped. Malformed YAML is
 * quarantined with a descriptive reason for later human repair.
 */

import { Command } from "commander";
import chalk from "chalk";
import yaml from "js-yaml";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname, resolve, relative, sep, basename } from "node:path";
import { ExitCode } from "../types.js";
import { validateAdapterV2 } from "../core/schema-v2.js";

/**
 * Capability inference map: pipeline step name → capability identifier.
 *
 * Capabilities are namespaced so the future capability-aware dispatcher
 * can select a transport. Steps not listed here are rare enough that the
 * migrator falls back to `http.fetch` as a conservative minimum.
 */
const STEP_CAPABILITY: Record<string, string> = {
  // HTTP transports
  fetch: "http.fetch",
  fetch_text: "http.fetch",
  parse_rss: "http.fetch",
  html_to_md: "http.fetch",
  // Browser / CDP transports
  navigate: "cdp-browser.navigate",
  evaluate: "cdp-browser.evaluate",
  click: "cdp-browser.click",
  type: "cdp-browser.type",
  press: "cdp-browser.press",
  scroll: "cdp-browser.scroll",
  snapshot: "cdp-browser.snapshot",
  intercept: "cdp-browser.intercept",
  tap: "cdp-browser.tap",
  extract: "cdp-browser.extract",
  // Subprocess transport (desktop / bridge)
  exec: "subprocess.exec",
  write_temp: "subprocess.exec",
  // macOS native desktop (Accessibility API + AppleScript)
  ax_focus: "desktop-ax.focus",
  ax_menu_select: "desktop-ax.menu_select",
  applescript: "desktop-ax.applescript",
  clipboard_read: "desktop-ax.clipboard",
  clipboard_write: "desktop-ax.clipboard",
  launch_app: "desktop-ax.launch_app",
  focus_window: "desktop-ax.focus_window",
  // Windows UIA
  uia_focus: "desktop-uia.focus",
  uia_click: "desktop-uia.click",
  uia_type: "desktop-uia.type",
  // Linux AT-SPI
  atspi_focus: "desktop-atspi.focus",
  atspi_click: "desktop-atspi.click",
  // Computer Use Agent (CUA)
  cua_snapshot: "cua.snapshot",
  cua_click: "cua.click",
  cua_type: "cua.type",
  cua_key: "cua.key",
  cua_scroll: "cua.scroll",
  cua_drag: "cua.drag",
  cua_wait: "cua.wait",
  // Media
  download: "http.download",
  // Service
  websocket: "net.websocket",
  // Control-flow steps don't map to a transport — skipped from inference.
};

/**
 * Priority order for choosing `minimum_capability`. Higher index = more
 * privileged. Subprocess wins because it mutates the host; then
 * cdp-browser (needs a live browser); then net.websocket; then http.
 */
const CAPABILITY_PRIORITY = [
  "http.fetch",
  "http.download",
  "net.websocket",
  "cdp-browser.navigate",
  "cdp-browser.click",
  "cdp-browser.type",
  "cdp-browser.press",
  "cdp-browser.scroll",
  "cdp-browser.snapshot",
  "cdp-browser.intercept",
  "cdp-browser.tap",
  "cdp-browser.extract",
  "cdp-browser.evaluate",
  // Desktop (requires host + a running app)
  "desktop-ax.clipboard",
  "desktop-ax.focus_window",
  "desktop-ax.launch_app",
  "desktop-ax.focus",
  "desktop-ax.menu_select",
  "desktop-ax.applescript",
  "desktop-uia.focus",
  "desktop-uia.click",
  "desktop-uia.type",
  "desktop-atspi.focus",
  "desktop-atspi.click",
  // CUA — model-in-the-loop screen automation, most privileged
  "cua.wait",
  "cua.snapshot",
  "cua.scroll",
  "cua.key",
  "cua.type",
  "cua.click",
  "cua.drag",
  // Subprocess mutates host — just below CUA
  "subprocess.exec",
];

/**
 * Site directories whose data is inherently private. A partial match on
 * the normalized site dir name bumps `confidentiality` to "private" —
 * purely informational for the future dispatcher, no runtime effect yet.
 */
const PRIVATE_SITE_PATTERNS = [
  "imessage",
  "mail",
  "gmail",
  "auth",
  "keychain",
  "password",
  "private",
  "inbox",
  "messenger",
  "whatsapp",
  "signal",
  "telegram",
  "dm",
];

/**
 * Required v2 fields. If all five are present, skip the file.
 */
const V2_FIELDS = [
  "capabilities",
  "minimum_capability",
  "trust",
  "confidentiality",
  "quarantine",
] as const;

export interface MigrationResult {
  migrated: string[];
  already_v2: string[];
  quarantined: Array<{ file: string; reason: string }>;
  skipped: Array<{ file: string; reason: string }>;
}

interface ParsedYaml {
  type?: string;
  pipeline?: unknown[];
  capabilities?: unknown;
  minimum_capability?: unknown;
  trust?: unknown;
  confidentiality?: unknown;
  quarantine?: unknown;
  quarantineReason?: unknown;
}

/** Recursively walk step objects collecting every action name. */
function collectStepNames(pipeline: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(pipeline)) return names;

  const queue: unknown[] = [...pipeline];
  while (queue.length) {
    const step = queue.shift();
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const rec = step as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key === "retry" || key === "continue_on_error" || key === "label")
        continue;
      names.add(key);
    }
    // Drill into nested pipelines
    for (const key of ["if", "each"]) {
      const config = rec[key];
      if (!config || typeof config !== "object") continue;
      for (const branch of ["then", "else", "do"] as const) {
        const sub = (config as Record<string, unknown>)[branch];
        if (Array.isArray(sub)) queue.push(...sub);
      }
    }
    const parallel = rec["parallel"];
    if (parallel && typeof parallel === "object") {
      const branches = (parallel as Record<string, unknown>)["branches"];
      if (Array.isArray(branches)) {
        for (const b of branches) {
          if (b && typeof b === "object") {
            const sub = (b as Record<string, unknown>)["pipeline"];
            if (Array.isArray(sub)) queue.push(...sub);
          }
        }
      }
    }
  }
  return names;
}

/** Infer the `capabilities` array from the pipeline steps. */
export function inferCapabilities(pipeline: unknown): string[] {
  const stepNames = collectStepNames(pipeline);
  const caps = new Set<string>();
  for (const step of stepNames) {
    const cap = STEP_CAPABILITY[step];
    if (cap) caps.add(cap);
  }
  return Array.from(caps).sort();
}

/**
 * Pick the highest-priority capability as the minimum bar. Falls back to
 * `http.fetch` (the baseline transport) when nothing maps.
 */
export function inferMinimumCapability(caps: string[]): string {
  if (caps.length === 0) return "http.fetch";
  let best = caps[0];
  let bestIdx = CAPABILITY_PRIORITY.indexOf(best);
  for (const c of caps) {
    const idx = CAPABILITY_PRIORITY.indexOf(c);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = c;
    }
  }
  return best;
}

/** Does the adapter mutate the host? Desktop type, exec, or any native UI step. */
function mutatesHost(parsed: ParsedYaml): boolean {
  if (parsed.type === "desktop") return true;
  const steps = collectStepNames(parsed.pipeline);
  if (steps.has("exec") || steps.has("write_temp")) return true;
  for (const s of steps) {
    if (
      s.startsWith("ax_") ||
      s.startsWith("uia_") ||
      s.startsWith("atspi_") ||
      s.startsWith("cua_") ||
      s === "applescript" ||
      s === "clipboard_read" ||
      s === "clipboard_write" ||
      s === "launch_app" ||
      s === "focus_window"
    ) {
      return true;
    }
  }
  return false;
}

/** Does the adapter path match a private data pattern? */
function isPrivatePath(adapterPath: string): boolean {
  // Normalize to forward slashes and lowercase for matching
  const norm = adapterPath.split(sep).join("/").toLowerCase();
  return PRIVATE_SITE_PATTERNS.some((p) => {
    // Match as a path segment, not substring — "mail" should match
    // src/adapters/mail/ but not src/adapters/gmail-adjacent/.
    return (
      norm.includes(`/${p}/`) ||
      norm.includes(`/${p}-`) ||
      norm.endsWith(`/${p}`)
    );
  });
}

/** Does the loaded YAML already have all five v2 fields present? */
function isAlreadyV2(parsed: ParsedYaml): boolean {
  return V2_FIELDS.every(
    (f) => (parsed as Record<string, unknown>)[f] !== undefined,
  );
}

/**
 * Append the new fields as a YAML text block. Preserves everything above
 * (comments, quoting, ordering) because we do not re-serialize the file.
 */
function buildAppendBlock(fields: {
  capabilities: string[];
  minimum_capability: string;
  trust: string;
  confidentiality: string;
  quarantine: boolean;
  quarantineReason?: string;
}): string {
  const lines: string[] = [
    "",
    "# schema-v2 metadata — injected by `unicli migrate schema-v2`",
    `capabilities: ${JSON.stringify(fields.capabilities)}`,
    `minimum_capability: ${fields.minimum_capability}`,
    `trust: ${fields.trust}`,
    `confidentiality: ${fields.confidentiality}`,
    `quarantine: ${fields.quarantine}`,
  ];
  if (fields.quarantine && fields.quarantineReason) {
    lines.push(`quarantineReason: ${JSON.stringify(fields.quarantineReason)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Post-migration roundtrip check: re-parse the rewritten text and run it
 * through the full schema-v2 validator. This catches cases where the naive
 * append strategy produces syntactically-valid YAML that still violates
 * schema-v2 (e.g. a pre-existing broken `pipeline` shape now carried into
 * a "migrated" file). On failure we tag the file for quarantine rather than
 * blessing an invalid adapter as migrated — the post-v212-rethink audit
 * identified the missing roundtrip as the loader-hard-gate's weakest point.
 */
function verifyRoundtrip(
  content: string,
  adapterPath: string,
): { ok: true } | { ok: false; error: string } {
  let reparsed: unknown;
  try {
    reparsed = yaml.load(content, { schema: yaml.CORE_SCHEMA });
  } catch (e) {
    return {
      ok: false,
      error: `reparse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!reparsed || typeof reparsed !== "object") {
    return { ok: false, error: "reparsed value is not an object" };
  }
  // Schema-v2 requires a `name` field — use the command name derived from
  // the adapter file path if the YAML omits it, since every file-resident
  // command borrows its name from basename.
  const cmdName = basename(adapterPath).replace(/\.(yaml|yml)$/i, "");
  const candidate: Record<string, unknown> = {
    name: cmdName,
    ...(reparsed as Record<string, unknown>),
  };
  const result = validateAdapterV2(candidate);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}

/** Migrate one YAML file. Returns the new file contents plus a status. */
export function migrateYamlText(
  raw: string,
  adapterPath: string,
):
  | { status: "migrated"; content: string }
  | { status: "already_v2" }
  | { status: "quarantine"; content: string; reason: string }
  | { status: "skip"; reason: string } {
  let parsed: ParsedYaml;
  try {
    parsed = yaml.load(raw) as ParsedYaml;
  } catch (err) {
    const reason =
      "malformed during schema-v2 sweep — needs manual review: " +
      (err instanceof Error ? err.message : String(err));
    // Per task spec: skip with a warning AND write quarantine. We honor
    // both by returning a quarantine marker the caller writes out.
    const quarantineAppend = buildAppendBlock({
      capabilities: [],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: true,
      quarantineReason: reason,
    });
    return {
      status: "quarantine",
      content: raw + quarantineAppend,
      reason,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      status: "skip",
      reason: "top-level value is not an object",
    };
  }

  if (isAlreadyV2(parsed)) {
    return { status: "already_v2" };
  }

  const capabilities = inferCapabilities(parsed.pipeline);
  const minimumCap = inferMinimumCapability(capabilities);
  const trust = mutatesHost(parsed) ? "user" : "public";
  const confidentiality = isPrivatePath(adapterPath) ? "private" : "public";
  const quarantine =
    typeof parsed.quarantine === "boolean" ? parsed.quarantine : false;
  const quarantineReason =
    typeof parsed.quarantineReason === "string"
      ? parsed.quarantineReason
      : undefined;

  // Merge-in strategy: only append the fields that are actually missing.
  // Existing fields (e.g. a hand-written `quarantine: true`) are preserved
  // in-place by the pure append approach.
  const missing: string[] = [];
  for (const f of V2_FIELDS) {
    if ((parsed as Record<string, unknown>)[f] === undefined) missing.push(f);
  }

  const appendLines: string[] = [
    "",
    "# schema-v2 metadata — injected by `unicli migrate schema-v2`",
  ];
  if (missing.includes("capabilities")) {
    appendLines.push(`capabilities: ${JSON.stringify(capabilities)}`);
  }
  if (missing.includes("minimum_capability")) {
    appendLines.push(`minimum_capability: ${minimumCap}`);
  }
  if (missing.includes("trust")) {
    appendLines.push(`trust: ${trust}`);
  }
  if (missing.includes("confidentiality")) {
    appendLines.push(`confidentiality: ${confidentiality}`);
  }
  if (missing.includes("quarantine")) {
    appendLines.push(`quarantine: ${quarantine}`);
    if (quarantine && quarantineReason) {
      appendLines.push(`quarantineReason: ${JSON.stringify(quarantineReason)}`);
    }
  }

  // Ensure the original content ends with a newline before appending.
  const base = raw.endsWith("\n") ? raw : raw + "\n";
  const content = base + appendLines.join("\n") + "\n";

  // Roundtrip — if the rewritten file no longer satisfies schema-v2, don't
  // pretend we migrated it. Quarantine with the reason so the operator can
  // either hand-fix or revert. This is the guard that keeps "887 YAMLs
  // migrated" from silently including invalid payloads.
  const check = verifyRoundtrip(content, adapterPath);
  if (!check.ok) {
    const reason = `roundtrip validation failed after migration — ${check.error}`;
    const quarantineAppend = buildAppendBlock({
      capabilities: [],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: true,
      quarantineReason: reason,
    });
    return {
      status: "quarantine",
      content: raw + quarantineAppend,
      reason,
    };
  }
  return { status: "migrated", content };
}

/** Recursively yield *.yaml / *.yml under a directory, skipping dotted/_ prefixed. */
function* walkYaml(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (extname(path) === ".yaml" || extname(path) === ".yml") yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    yield* walkYaml(join(path, entry));
  }
}

export function runMigration(
  target: string,
  opts: { dryRun?: boolean } = {},
): MigrationResult {
  const result: MigrationResult = {
    migrated: [],
    already_v2: [],
    quarantined: [],
    skipped: [],
  };

  for (const file of walkYaml(target)) {
    const rel = relative(process.cwd(), file);
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch (err) {
      result.skipped.push({
        file: rel,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const outcome = migrateYamlText(raw, file);

    if (outcome.status === "already_v2") {
      result.already_v2.push(rel);
      continue;
    }

    if (outcome.status === "skip") {
      result.skipped.push({ file: rel, reason: outcome.reason });
      continue;
    }

    if (outcome.status === "quarantine") {
      result.quarantined.push({ file: rel, reason: outcome.reason });
      if (!opts.dryRun) writeFileSync(file, outcome.content, "utf-8");
      process.stderr.write(
        chalk.yellow(`quarantined ${rel}: ${outcome.reason}\n`),
      );
      continue;
    }

    // migrated
    if (!opts.dryRun) writeFileSync(file, outcome.content, "utf-8");
    result.migrated.push(rel);
  }

  return result;
}

function resolveTarget(arg: string | undefined): string {
  return resolve(arg ?? "src/adapters");
}

export function registerMigrateSchemaCommand(program: Command): void {
  const migrate = program
    .command("migrate")
    .description("Schema migration utilities");

  migrate
    .command("schema-v2 [path]")
    .description("Mass-migrate v1 YAML adapters to schema v2 (idempotent)")
    .option("--dry-run", "do not write files, just print the plan")
    .option("--json", "emit a structured JSON report")
    .action(
      (
        path: string | undefined,
        opts: { dryRun?: boolean; json?: boolean },
      ) => {
        const target = resolveTarget(path);

        let stat;
        try {
          stat = statSync(target);
        } catch {
          console.error(chalk.red(`migrate target not found: ${target}`));
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (!stat.isDirectory() && !stat.isFile()) {
          console.error(chalk.red(`migrate target not usable: ${target}`));
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const report = runMigration(target, { dryRun: opts.dryRun });

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log(
          chalk.bold(
            `unicli migrate schema-v2 — ${opts.dryRun ? "dry run" : "applied"} on ${target}`,
          ),
        );
        console.log(
          `  ${chalk.green(report.migrated.length + " migrated")}` +
            `, ${chalk.dim(report.already_v2.length + " already v2")}` +
            `, ${chalk.yellow(report.quarantined.length + " quarantined")}` +
            `, ${chalk.red(report.skipped.length + " skipped")}`,
        );

        if (report.quarantined.length > 0) {
          console.log(chalk.yellow("\nQuarantined:"));
          for (const q of report.quarantined) {
            console.log(`  - ${q.file}: ${q.reason}`);
          }
        }
        if (report.skipped.length > 0) {
          console.log(chalk.red("\nSkipped:"));
          for (const s of report.skipped) {
            console.log(`  - ${s.file}: ${s.reason}`);
          }
        }
      },
    );
}
