/**
 * Cross-vendor SKILL.md loader.
 *
 * Discovers SKILL.md files across three roots:
 *   1. <repo>/skills/<name>/SKILL.md               — committed, cross-vendor
 *   2. $HOME/.unicli/skills/<name>/SKILL.md        — user-local overrides
 *   3. $XDG_DATA_HOME/unicli/skills/<name>/SKILL.md (with fallback to
 *      $HOME/.local/share/unicli/skills on XDG-compliant systems)
 *
 * The canonical frontmatter fields (per Anthropic's evolving spec plus
 * our protocol-v2 extensions) are:
 *
 *   name          required  kebab-case identifier
 *   description   required  why/when to use the skill
 *   triggers      optional  array of keywords/phrases
 *   version       optional  semver
 *   depends-on    optional  array of skill names this one composes
 *   protocol      optional  protocol version (we emit 2.0)
 *   allowed-tools optional  array of tool names the skill may use
 *   pipeline      optional  inline Uni-CLI pipeline — makes the skill
 *                           executable instead of informational
 *
 * This loader is deliberately permissive: unknown fields are preserved on
 * `raw` so consumers can read forward-compatible extensions without the
 * loader needing to know about them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { PipelineStep } from "../types.js";

export interface Skill {
  /** kebab-case identifier */
  name: string;
  description: string;
  triggers: string[];
  version?: string;
  dependsOn: string[];
  protocol?: string;
  allowedTools: string[];
  /** Inline pipeline — if present, `unicli skills invoke` runs it */
  pipeline?: PipelineStep[];
  /** Markdown body (everything after the closing frontmatter delimiter) */
  body: string;
  /** Absolute path to the SKILL.md file on disk */
  path: string;
  /** One of "repo" | "user" | "xdg" — useful for debugging precedence */
  source: SkillSource;
  /** Raw parsed frontmatter — forward-compatible access to unknown keys */
  raw: Record<string, unknown>;
}

export type SkillSource = "repo" | "user" | "xdg";

export interface LoadSkillsOptions {
  /**
   * Root directory for the "repo" scan — defaults to `<cwd>/skills`. Tests
   * override this; CLI callers can point to a known skills repo.
   */
  repoDir?: string;
  /** Override the HOME root. Tests use this to isolate the user scan. */
  homeDir?: string;
  /**
   * Extra roots appended after the three standard ones — plugins may use
   * this to contribute skills without touching the main directories.
   */
  extraDirs?: string[];
}

/** Default list of skill search roots, in precedence order (first wins). */
export function defaultSkillRoots(
  opts: LoadSkillsOptions = {},
): Array<{ dir: string; source: SkillSource }> {
  const home = opts.homeDir ?? homedir();
  const xdgData =
    process.env.XDG_DATA_HOME ??
    (home ? join(home, ".local", "share") : undefined);

  const roots: Array<{ dir: string; source: SkillSource }> = [];
  roots.push({
    dir: opts.repoDir ?? resolve(process.cwd(), "skills"),
    source: "repo",
  });
  if (home) {
    roots.push({ dir: join(home, ".unicli", "skills"), source: "user" });
  }
  if (xdgData) {
    roots.push({ dir: join(xdgData, "unicli", "skills"), source: "xdg" });
  }
  for (const extra of opts.extraDirs ?? []) {
    roots.push({ dir: extra, source: "repo" });
  }
  return roots;
}

/**
 * Load all SKILL.md files from the standard roots. When the same skill
 * name appears in multiple roots, the first one wins (repo → user → xdg
 * → extras). Returns a sorted array for deterministic output.
 */
export function loadSkills(opts: LoadSkillsOptions = {}): Skill[] {
  const seen = new Map<string, Skill>();
  for (const { dir, source } of defaultSkillRoots(opts)) {
    if (!existsSync(dir)) continue;
    for (const skill of scanDirectory(dir, source)) {
      if (!seen.has(skill.name)) {
        seen.set(skill.name, skill);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scan one directory for `<subdir>/SKILL.md` files. Silently skips files
 * that fail to parse — the loader's contract is "best effort, never
 * throw" so one bad skill does not break discovery.
 */
function scanDirectory(dir: string, source: SkillSource): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const subPath = join(dir, name);
    let stat;
    try {
      stat = statSync(subPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skillFile = join(subPath, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFile(skillFile, source);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Parse one SKILL.md file. Returns `undefined` when the frontmatter is
 * missing or the required `name` / `description` fields are absent.
 */
export function parseSkillFile(
  absPath: string,
  source: SkillSource,
): Skill | undefined {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) return undefined;

  const { frontmatter, body } = parsed;
  const name =
    typeof frontmatter.name === "string" && frontmatter.name.length > 0
      ? frontmatter.name
      : basename(absPath, ".md").replace(/\/SKILL$/, "");
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";
  if (!name || !description) return undefined;

  const triggers = toStringArray(frontmatter.triggers);
  const dependsOn = toStringArray(
    frontmatter["depends-on"] ?? frontmatter.dependsOn,
  );
  const allowedTools = toStringArray(
    frontmatter["allowed-tools"] ?? frontmatter.allowedTools,
  );
  const version =
    typeof frontmatter.version === "string" ? frontmatter.version : undefined;
  const protocol =
    typeof frontmatter.protocol === "string"
      ? frontmatter.protocol
      : typeof frontmatter.protocol === "number"
        ? String(frontmatter.protocol)
        : undefined;

  const pipeline = extractPipeline(frontmatter, body);

  return {
    name,
    description,
    triggers,
    version,
    dependsOn,
    protocol,
    allowedTools,
    pipeline,
    body,
    path: absPath,
    source,
    raw: frontmatter,
  };
}

/**
 * Match skills whose triggers contain any of the query tokens. Split
 * each trigger string on non-alphanumeric boundaries so "check twitter"
 * matches a query of "twitter". Purely advisory — callers still decide.
 */
export function matchTrigger(skills: Skill[], query: string): Skill[] {
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  return skills.filter((s) => {
    const haystack = [
      s.name.toLowerCase(),
      s.description.toLowerCase(),
      ...s.triggers.map((t) => t.toLowerCase()),
    ].join(" ");
    return tokens.some((t) => haystack.includes(t));
  });
}

/**
 * Resolve transitive dependencies of a skill. Returns the set of skill
 * names (including the starting skill) reachable via `depends-on` edges,
 * with cycle protection. Missing dependencies are silently skipped —
 * the loader's job is to report what IS present, not what's missing.
 */
export function resolveDependencies(skills: Skill[], start: string): string[] {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const visited = new Set<string>();
  const order: string[] = [];
  const walk = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const skill = byName.get(name);
    if (!skill) return;
    for (const dep of skill.dependsOn) walk(dep);
    order.push(name);
  };
  walk(start);
  return order;
}

// ── Internals ───────────────────────────────────────────────────────────────

interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a markdown document into frontmatter + body. Returns `undefined`
 * when there is no opening `---` on the first non-blank line.
 *
 * We purposefully accept both LF and CRLF to handle files written on
 * Windows — the frontmatter contract is whitespace-insensitive and
 * splitting on /\r?\n/ catches both.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter | undefined {
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length || lines[i].trim() !== "---") return undefined;

  let end = -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "---") {
      end = j;
      break;
    }
  }
  if (end < 0) return undefined;

  const fmText = lines.slice(i + 1, end).join("\n");
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");

  let frontmatter: unknown;
  try {
    frontmatter = yaml.load(fmText);
  } catch {
    return undefined;
  }
  if (!frontmatter || typeof frontmatter !== "object") return undefined;
  return {
    frontmatter: frontmatter as Record<string, unknown>,
    body,
  };
}

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Look for an inline pipeline. Two shapes are supported:
 *   1. `pipeline:` key directly in the YAML frontmatter.
 *   2. A fenced `yaml` / `unicli` code block in the body with a top-level
 *      `pipeline:` node. This keeps the frontmatter lean while allowing
 *      authors to include a runnable recipe.
 */
function extractPipeline(
  frontmatter: Record<string, unknown>,
  body: string,
): PipelineStep[] | undefined {
  const fromFm = frontmatter.pipeline;
  if (Array.isArray(fromFm)) return fromFm as PipelineStep[];

  const fenceMatch = body.match(/```(?:yaml|unicli)\n([\s\S]*?)\n```/);
  if (!fenceMatch) return undefined;
  try {
    const parsed = yaml.load(fenceMatch[1]) as { pipeline?: unknown };
    if (parsed && Array.isArray(parsed.pipeline)) {
      return parsed.pipeline as PipelineStep[];
    }
  } catch {
    return undefined;
  }
  return undefined;
}
