#!/usr/bin/env tsx
/**
 * Codemod — declare `format:` / `x-unicli-kind:` / `x-unicli-accepts:` on
 * every adapter arg so the ajv schema-driven hardening shipped in P1 covers
 * 1355 args across ~797 YAML files without per-adapter hand review.
 *
 * Rules (applied in order; first match wins):
 *   0. Override table — 31 edge cases from the P1 audit that need both a
 *      primary kind and an `x-unicli-accepts` fallback.
 *   1. `format:` OR `x-unicli-kind:` already present → keep.
 *   2. Name matches /(^|_)url$/i  OR description starts with `URL`
 *        → format: uri
 *   3. Name matches /(^|_)(path|file|output|dir|dest|destination|save_to|cookies_file)(_|$)/i
 *        → x-unicli-kind: path
 *   4. Name matches /(^|_)id$/ AND description does NOT contain `url`
 *        (case-insensitive) → x-unicli-kind: id
 *      NOTE: `x-unicli-kind: id` is not a validator in harden.ts today;
 *      it's an annotation that tools / future validators can key off.
 *   5. Name is `email` → format: email
 *   6. Name contains `date` or `timestamp` → format: date-time
 *   7. Else → no annotation (freeform, unchecked by ajv).
 *
 * Also — for each command whose pipeline references `next_cursor` anywhere
 * in a `select:` / `map:` / `set:` step, set `paginated: true` on the
 * command. No adapter currently emits `next_cursor`, but the scan stays in
 * so future adapters don't need a separate codemod.
 *
 * Editing strategy: line-surgery, not roundtrip. We parse the YAML with the
 * `yaml` package purely to discover arg-block extents (via `LineCounter`),
 * then insert new lines at the calculated offsets. This preserves every
 * comment, quote style, flow-sequence spacing, and blank line in the
 * source — a full roundtrip via `new Document` reflows the file.
 *
 * Usage:
 *   tsx scripts/migrate-add-kind.ts             # apply in-place
 *   tsx scripts/migrate-add-kind.ts --check     # dry-run; exit 1 if any change pending
 *   tsx scripts/migrate-add-kind.ts --conflicts # print conflict report, no writes
 *
 * Exit codes:
 *   0 — clean (or --check with no pending changes)
 *   1 — I/O failure OR --check detected pending changes
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument, isMap, LineCounter } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(REPO_ROOT, "src", "adapters");
const CONFLICTS_OUT = join(
  REPO_ROOT,
  "docs",
  "codemod",
  "v0.213.3-conflicts.md",
);

/* ─────────── types ─────────── */

export type Action =
  | { kind: "skip"; reason: string }
  | { kind: "annotate"; lines: string[]; rule: string; category?: string };

/* ─────────── override table (30 entries) ─────────── */

interface Override {
  adapter: string;
  command: string;
  argName: string;
  /** Primary annotation lines (in children indentation, without the leading spaces). */
  primary: string[];
  /** Human-readable group for the conflict report. */
  group: "A" | "B" | "C";
  note: string;
}

const OVERRIDES: Override[] = [
  // Group A — zhihu/douban/jike/xiaoyuzhou id args that hold URL slugs (12)
  // All get `x-unicli-kind: id` + `x-unicli-accepts: [url]`.
  ...(
    [
      ["zhihu", "answers", "User URL token"],
      ["zhihu", "articles", "User URL token"],
      ["zhihu", "collections", "User URL token"],
      ["zhihu", "columns", "Column ID (URL slug)"],
      ["zhihu", "followers", "User URL token"],
      ["zhihu", "following", "User URL token"],
      ["zhihu", "pins", "User URL token"],
      ["zhihu", "user", "User URL token"],
      ["douban", "subject", "Subject ID (from URL)"],
      ["jike", "post", "Post ID (from post URL)"],
      ["jike", "topic", "Topic ID (from topic URL)"],
      ["xiaoyuzhou", "podcast", "Podcast ID (from xiaoyuzhoufm.com URL)"],
    ] as const
  ).map<Override>(([adapter, command, note]) => ({
    adapter,
    command,
    argName: "id",
    primary: [`x-unicli-kind: id`, `x-unicli-accepts: [url]`],
    group: "A",
    note,
  })),

  // Group B — url args that also accept bare IDs (7)
  // All get `format: uri` + `x-unicli-accepts: [id]`.
  ...(
    [
      ["twitter", "quotes", "Tweet URL or ID"],
      ["boss", "detail", "Job detail URL or encrypted job ID"],
      ["paperreview", "submit", "URL or arXiv ID of paper"],
      ["paperreview", "feedback", "URL or arXiv ID of paper"],
      ["paperreview", "review", "URL or arXiv ID of paper"],
      ["reddit", "comments", "Reddit post URL or ID"],
    ] as const
  ).map<Override>(([adapter, command, note]) => ({
    adapter,
    command,
    argName: "url",
    primary: [`format: uri`, `x-unicli-accepts: [id]`],
    group: "B",
    note,
  })),

  // Group C — path-like args that also accept URLs (12 entries, incl reuters/article)
  // All get `x-unicli-kind: path` + `x-unicli-accepts: [url]`.
  ...(
    [
      ["yollomi", "restore", "image", "Image URL or local path"],
      ["yollomi", "upload", "image", "Image URL or local file path"],
      ["yollomi", "edit", "image", "Image URL or local path"],
      ["yollomi", "upscale", "image", "Image URL or local path"],
      ["yollomi", "remove-bg", "image", "Image URL or local path"],
      ["macos", "open", "target", "File path, URL, or application name"],
      ["amazon", "bestsellers", "url", "Best sellers URL or category path"],
      ["amazon", "new-releases", "url", "New releases URL or category path"],
      [
        "amazon",
        "movers-shakers",
        "url",
        "Movers & Shakers URL or category path",
      ],
      ["reuters", "article", "url", "Article URL path"],
      ["facebook", "join-group", "group", "Group ID or URL path"],
      ["wiremock", "create-stub", "url", "URL path to match"],
    ] as const
  ).map<Override>(([adapter, command, argName, note]) => ({
    adapter,
    command,
    argName,
    primary: [`x-unicli-kind: path`, `x-unicli-accepts: [url]`],
    group: "C",
    note,
  })),
];

const OVERRIDE_KEY = new Map<string, Override>(
  OVERRIDES.map((o) => [`${o.adapter}/${o.command}/${o.argName}`, o]),
);

/* ─────────── rule engine ─────────── */

export function classifyArg(
  adapter: string,
  command: string,
  argName: string,
  description: string | undefined,
  existingKeys: Set<string>,
): Action {
  // Rule 1 — already annotated: keep untouched.
  if (
    existingKeys.has("format") ||
    existingKeys.has("x-unicli-kind") ||
    existingKeys.has("x-unicli-accepts")
  ) {
    return { kind: "skip", reason: "already-annotated" };
  }

  // Rule 0 — override table (edge cases from P1 audit).
  const hit = OVERRIDE_KEY.get(`${adapter}/${command}/${argName}`);
  if (hit) {
    return {
      kind: "annotate",
      lines: hit.primary.slice(),
      rule: "rule0-override",
      category: `group${hit.group}`,
    };
  }

  const desc = description ?? "";
  const descLower = desc.toLowerCase();

  // Rule 2 — URI.
  if (/(^|_)url$/i.test(argName)) {
    return { kind: "annotate", lines: [`format: uri`], rule: "rule2-url-name" };
  }
  if (desc.startsWith("URL")) {
    return { kind: "annotate", lines: [`format: uri`], rule: "rule2-url-desc" };
  }

  // Rule 3 — filesystem path.
  if (
    /(^|_)(path|file|output|dir|dest|destination|save_to|cookies_file)(_|$)/i.test(
      argName,
    )
  ) {
    return {
      kind: "annotate",
      lines: [`x-unicli-kind: path`],
      rule: "rule3-path-like",
    };
  }

  // Rule 4 — identifier (not dressed-up URL).
  if (/(^|_)id$/.test(argName) && !descLower.includes("url")) {
    return {
      kind: "annotate",
      lines: [`x-unicli-kind: id`],
      rule: "rule4-id",
    };
  }

  // Rule 5 — email.
  if (argName === "email") {
    return { kind: "annotate", lines: [`format: email`], rule: "rule5-email" };
  }

  // Rule 6 — date / timestamp.
  if (argName.includes("date") || argName.includes("timestamp")) {
    return {
      kind: "annotate",
      lines: [`format: date-time`],
      rule: "rule6-date",
    };
  }

  return { kind: "skip", reason: "freeform" };
}

/* ─────────── pagination detection ─────────── */

/** Returns true if the file contains `next_cursor` in a pipeline context. */
export function detectPaginated(src: string): boolean {
  // Rough but safe: presence of `next_cursor` anywhere below the pipeline:
  // keyword. The string rarely appears outside actual pagination refs.
  const pipelineIdx = src.indexOf("\npipeline:");
  if (pipelineIdx < 0) return src.includes("next_cursor");
  return src.slice(pipelineIdx).includes("next_cursor");
}

/* ─────────── YAML surgery ─────────── */

interface FileResult {
  file: string;
  site: string;
  command: string;
  argsMigrated: number;
  argsSkipped: number;
  overridesApplied: number;
  paginatedAdded: boolean;
  newSrc?: string;
  conflicts: Array<{ argName: string; group: "A" | "B" | "C"; note: string }>;
}

export function processFile(absPath: string, src: string): FileResult {
  const lc = new LineCounter();
  const doc = parseDocument(src, { lineCounter: lc });

  const site = String(doc.get("site") ?? "");
  const command = String(doc.get("name") ?? "");

  const result: FileResult = {
    file: absPath,
    site,
    command,
    argsMigrated: 0,
    argsSkipped: 0,
    overridesApplied: 0,
    paginatedAdded: false,
    conflicts: [],
  };

  const argsNode = doc.get("args", true);
  const insertions: Array<{ line: number; content: string[] }> = [];

  if (isMap(argsNode)) {
    for (const pair of argsNode.items) {
      const argName = String(pair.key);
      const valNode = pair.value;
      if (!isMap(valNode) || valNode.items.length === 0) {
        // Null-value args (e.g. `foo:` alone) — cannot find a lastChildLine;
        // skip hardening.
        result.argsSkipped++;
        continue;
      }
      const existingKeys = new Set<string>(
        valNode.items.map((p) => String(p.key)),
      );
      let description: string | undefined;
      const descNode = valNode.get("description");
      if (descNode !== undefined && descNode !== null) {
        description = String(descNode);
      }

      const action = classifyArg(
        site,
        command,
        argName,
        description,
        existingKeys,
      );
      if (action.kind === "skip") {
        result.argsSkipped++;
        continue;
      }

      // Find insertion point: the line after the last child's content.
      const last = valNode.items[valNode.items.length - 1];
      const lastEnd = last.value?.range?.[1] ?? last.key.range[1];
      const pos = lc.linePos(lastEnd);
      const lastContentLine = pos.col === 1 ? pos.line - 1 : pos.line;

      // Indent is the column of the first child's key.
      const firstChild = valNode.items[0];
      const fPos = lc.linePos(firstChild.key.range[0]);
      const childIndent = fPos.col - 1; // col is 1-based

      const pad = " ".repeat(childIndent);
      insertions.push({
        line: lastContentLine, // insert AFTER this 1-based line
        content: action.lines.map((l) => pad + l),
      });
      result.argsMigrated++;

      if (action.rule === "rule0-override") {
        result.overridesApplied++;
        const ov = OVERRIDE_KEY.get(`${site}/${command}/${argName}`)!;
        result.conflicts.push({
          argName,
          group: ov.group,
          note: ov.note,
        });
      }
    }
  }

  // Pagination scan — only applies when the doc doesn't already have
  // `paginated:` at top level.
  const hasPaginated = doc.has("paginated");
  let paginatedInsertLine: number | undefined;
  if (!hasPaginated && detectPaginated(src)) {
    // Insert `paginated: true` at the top level, after the last known metadata
    // line and before `pipeline:` if possible. Simplest heuristic: put it just
    // before the first blank line that precedes `pipeline:`.
    const lines = src.split("\n");
    const pipeIdx = lines.findIndex((l) => l.startsWith("pipeline:"));
    if (pipeIdx > 0) {
      // Walk back over blank lines to land just after the last non-blank line.
      let anchor = pipeIdx - 1;
      while (anchor >= 0 && lines[anchor].trim() === "") anchor--;
      if (anchor >= 0) paginatedInsertLine = anchor + 1; // 1-based
    }
    if (paginatedInsertLine !== undefined) {
      insertions.push({
        line: paginatedInsertLine,
        content: [`paginated: true`],
      });
      result.paginatedAdded = true;
    }
  }

  if (insertions.length === 0) {
    return result;
  }

  // Apply all insertions. Work from bottom to top so earlier inserts don't
  // shift later indices.
  insertions.sort((a, b) => b.line - a.line);
  const lines = src.split("\n");
  for (const ins of insertions) {
    // Insert after index `ins.line - 1` (1-based → 0-based) i.e. at position ins.line.
    lines.splice(ins.line, 0, ...ins.content);
  }
  result.newSrc = lines.join("\n");
  return result;
}

/* ─────────── filesystem walk ─────────── */

function walkYaml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkYaml(full));
    } else if (s.isFile() && full.endsWith(".yaml")) {
      out.push(full);
    }
  }
  return out;
}

/* ─────────── conflict report ─────────── */

export function writeConflictsMarkdown(
  _allResults: FileResult[],
  outPath: string,
): string {
  // The conflict report enumerates the static override table so the report
  // stays accurate even when the codemod runs in idempotent mode (nothing
  // pending, but the 30 overrides are still declared).
  const groups: Record<"A" | "B" | "C", string[]> = { A: [], B: [], C: [] };
  for (const o of OVERRIDES) {
    const rel = `src/adapters/${o.adapter}/${o.command}.yaml`;
    groups[o.group].push(
      `| \`${o.adapter}/${o.command}\` | \`${o.argName}\` | ${o.note} | \`${rel}\` |`,
    );
  }

  const md = `# v0.213.3 codemod — conflict report

Generated by \`scripts/migrate-add-kind.ts\`. Each row is an adapter/command/arg
triplet where the P1 audit flagged an edge case that rule-based classification
would mis-handle. The override table inside the codemod applies the correct
\`x-unicli-kind:\` + \`x-unicli-accepts:\` pair at runtime — no hand edits needed.

## Group A — id args that hold URL slugs

\`x-unicli-kind: id\` + \`x-unicli-accepts: [url]\`

| Adapter | Arg | Description | File |
| --- | --- | --- | --- |
${groups.A.sort().join("\n")}

## Group B — url args that also accept bare IDs

\`format: uri\` + \`x-unicli-accepts: [id]\`

| Adapter | Arg | Description | File |
| --- | --- | --- | --- |
${groups.B.sort().join("\n")}

## Group C — path-like args that also accept URLs

\`x-unicli-kind: path\` + \`x-unicli-accepts: [url]\`

| Adapter | Arg | Description | File |
| --- | --- | --- | --- |
${groups.C.sort().join("\n")}

**Totals**: A=${groups.A.length} · B=${groups.B.length} · C=${groups.C.length} · grand=${groups.A.length + groups.B.length + groups.C.length}
`;

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, "utf-8");
  return md;
}

/* ─────────── CLI entrypoint ─────────── */

interface RunSummary {
  filesScanned: number;
  filesChanged: number;
  argsMigrated: number;
  argsSkipped: number;
  overridesApplied: number;
  paginatedCommands: string[];
}

export function run(options: {
  check?: boolean;
  conflictsOnly?: boolean;
  adaptersDir?: string;
  writeConflicts?: boolean;
}): RunSummary & { results: FileResult[] } {
  const dir = options.adaptersDir ?? ADAPTERS_DIR;
  const files = walkYaml(dir);

  const results: FileResult[] = [];
  const summary: RunSummary = {
    filesScanned: files.length,
    filesChanged: 0,
    argsMigrated: 0,
    argsSkipped: 0,
    overridesApplied: 0,
    paginatedCommands: [],
  };

  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    const r = processFile(file, src);
    results.push(r);
    summary.argsMigrated += r.argsMigrated;
    summary.argsSkipped += r.argsSkipped;
    summary.overridesApplied += r.overridesApplied;
    if (r.paginatedAdded) {
      summary.paginatedCommands.push(`${r.site}/${r.command}`);
    }
    if (r.newSrc && r.newSrc !== src) {
      summary.filesChanged++;
      if (!options.check && !options.conflictsOnly) {
        writeFileSync(file, r.newSrc, "utf-8");
      }
    }
  }

  if (options.writeConflicts !== false) {
    writeConflictsMarkdown(results, CONFLICTS_OUT);
  }

  return { ...summary, results };
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const conflictsOnly = argv.includes("--conflicts");

  const {
    filesScanned,
    filesChanged,
    argsMigrated,
    overridesApplied,
    paginatedCommands,
  } = run({ check, conflictsOnly });

  const tag = check ? "[check]" : conflictsOnly ? "[conflicts]" : "[apply]";
  process.stderr.write(
    `${tag} scanned=${filesScanned} changed=${filesChanged} args_migrated=${argsMigrated} overrides=${overridesApplied} paginated=${paginatedCommands.length}\n`,
  );
  if (paginatedCommands.length > 0) {
    process.stderr.write(`${tag} paginated: ${paginatedCommands.join(", ")}\n`);
  }

  if (check && filesChanged > 0) {
    process.stderr.write(
      `${tag} ${filesChanged} file(s) would change — re-run without --check.\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
