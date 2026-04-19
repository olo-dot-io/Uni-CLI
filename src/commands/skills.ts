/**
 * Skills export command — generate Anthropic SKILL.md frontmatter for every adapter.
 *
 *   unicli skills export [--out skills/]
 *   unicli skills publish [--to ~/.claude/skills/uni-cli/]
 *   unicli skills catalog [--out docs/adapters-catalog.json]
 *
 * Why this exists:
 *   The Anthropic SKILL.md spec is becoming the de-facto standard for agent
 *   capability discovery (Claude Code, Codex, Cursor, Cline, Windsurf all read
 *   it). This command emits one SKILL.md per adapter command from the existing
 *   YAML/TS metadata, enabling agent discovery without separate documentation.
 *
 * Output shape (per adapter command):
 *   skills/<site>/<command>.md
 *   ---
 *   name: <site>-<command>
 *   description: <one-line, from adapter description>
 *   when_to_use: <heuristic from command name + columns>
 *   source: unicli@<version>
 *   command: unicli <site> <command>
 *   ---
 *   <2-paragraph body>
 */

import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { getAllAdapters } from "../registry.js";
import { VERSION } from "../constants.js";
import type {
  AdapterManifest,
  AdapterCommand,
  OutputFormat,
} from "../types.js";
import { ExitCode } from "../types.js";
import { loadSkills, type Skill } from "../protocol/skill.js";
import { runPipeline } from "../engine/executor.js";
import { format, detectFormat } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import { errorTypeToCode, mapErrorToExitCode } from "../output/error-map.js";

interface ExportOptions {
  out?: string;
}

interface PublishOptions {
  to?: string;
}

interface CatalogOptions {
  out?: string;
}

interface SkillFile {
  /** Frontmatter name field — always `<site>-<command>` */
  name: string;
  description: string;
  whenToUse: string;
  command: string;
  source: string;
  body: string;
  /** Relative path under the export root, e.g. "hackernews/top.md" */
  relativePath: string;
}

/**
 * Build a SKILL.md file for one adapter command.
 *
 * The frontmatter is intentionally narrow — Anthropic's spec asks for just
 * `name` and `description` plus optional fields that consumers may use for
 * filtering. The body keeps the file useful for humans browsing the directory.
 */
export function buildSkillForCommand(
  adapter: AdapterManifest,
  cmdName: string,
  cmd: AdapterCommand,
): SkillFile {
  const name = `${adapter.name}-${cmdName}`;
  const description =
    cmd.description?.trim() ||
    adapter.description?.trim() ||
    `${cmdName} command for ${adapter.name}`;

  const whenToUse = inferWhenToUse(adapter, cmdName, cmd);
  const command = `unicli ${adapter.name} ${cmdName}`;

  // Build a usage hint that includes positional + most useful option args.
  const args = cmd.adapterArgs ?? [];
  const usageBits: string[] = [`unicli ${adapter.name} ${cmdName}`];
  for (const a of args) {
    if (a.positional) {
      usageBits.push(a.required ? `<${a.name}>` : `[${a.name}]`);
    }
  }
  const optionFlags = args
    .filter((a) => !a.positional)
    .slice(0, 4)
    .map(
      (a) => `[--${a.name}${a.default !== undefined ? ` ${a.default}` : ""}]`,
    );
  const usageLine = [...usageBits, ...optionFlags].join(" ");

  const columnsLine =
    cmd.columns && cmd.columns.length > 0
      ? `Returns columns: \`${cmd.columns.join("`, `")}\`.`
      : "Returns JSON results.";

  const authNote =
    adapter.strategy && adapter.strategy !== "public"
      ? `\n\n**Auth required.** Run \`unicli auth setup ${adapter.name}\` once before invoking — the strategy is \`${adapter.strategy}\`.`
      : "";

  const body = `## What it does

${description}. ${columnsLine}${authNote}

## How to call it

\`\`\`bash
${usageLine}
\`\`\`

Add \`--format json\` for piped output (auto-detected when stdout is not a TTY) and \`--limit N\` to cap result count. All Uni-CLI commands return structured JSON errors on stderr with the failing pipeline step and a repair suggestion.
`;

  return {
    name,
    description,
    whenToUse,
    command,
    source: `unicli@${VERSION}`,
    body,
    relativePath: `${adapter.name}/${cmdName}.md`,
  };
}

/**
 * Infer a "when to use" hint from the command name + adapter category.
 *
 * Pure heuristic — designed to be helpful without making things up. The
 * patterns reflect the most common command-name verbs across the adapter
 * catalog (search, top, list, get, download, post, ...).
 */
function inferWhenToUse(
  adapter: AdapterManifest,
  cmdName: string,
  cmd: AdapterCommand,
): string {
  const verb = cmdName.toLowerCase();
  const site = adapter.displayName ?? adapter.name;

  if (
    verb === "top" ||
    verb === "trending" ||
    verb === "hot" ||
    verb === "rank"
  )
    return `When you need the current ${verb} items from ${site}.`;
  if (verb === "search" || verb.startsWith("search"))
    return `When you need to search ${site} for a specific query.`;
  if (verb === "list" || verb.startsWith("list"))
    return `When you need to list items from ${site}.`;
  if (
    verb === "get" ||
    verb.startsWith("get") ||
    verb === "info" ||
    verb === "detail"
  )
    return `When you need details about a specific item on ${site}.`;
  if (verb === "download" || verb.startsWith("download"))
    return `When you need to download media or files from ${site}.`;
  if (verb === "post" || verb === "send" || verb === "create")
    return `When you need to post content to ${site}.`;
  if (verb === "comments" || verb === "replies")
    return `When you need to read comments/replies from ${site}.`;
  if (verb === "user" || verb === "profile")
    return `When you need user/profile info from ${site}.`;

  // Fall back to the description if it exists, otherwise generic.
  if (cmd.description) return cmd.description.trim();
  return `When you need the ${cmdName} capability from ${site}.`;
}

/**
 * Render a SkillFile to its on-disk markdown form (frontmatter + body).
 */
export function renderSkillMarkdown(skill: SkillFile): string {
  const fm = [
    "---",
    `name: ${skill.name}`,
    `description: ${escapeYamlValue(skill.description)}`,
    `when_to_use: ${escapeYamlValue(skill.whenToUse)}`,
    `command: ${skill.command}`,
    `source: ${skill.source}`,
    "---",
    "",
  ].join("\n");
  return fm + skill.body;
}

/**
 * Quote any YAML scalar that contains characters needing escaping. Keeps the
 * frontmatter parser-friendly without depending on a yaml library at write
 * time (read time uses js-yaml; write time keeps the surface area small).
 */
function escapeYamlValue(v: string): string {
  // Single line — strip newlines defensively
  const oneLine = v.replace(/\r?\n/g, " ").trim();
  if (/[:#&*!|>'"%@`,\[\]{}]/.test(oneLine) || /^\s|\s$/.test(oneLine)) {
    return `"${oneLine.replace(/"/g, '\\"')}"`;
  }
  return oneLine;
}

/**
 * Walk every loaded adapter and emit a SKILL.md per command into `outDir`.
 * Returns the count of files written.
 */
export function exportSkills(outDir: string): number {
  const adapters = getAllAdapters();
  let written = 0;
  for (const adapter of adapters) {
    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      const skill = buildSkillForCommand(adapter, cmdName, cmd);
      const dest = join(outDir, skill.relativePath);
      mkdirSync(join(outDir, adapter.name), { recursive: true });
      writeFileSync(dest, renderSkillMarkdown(skill), "utf-8");
      written++;
    }
  }
  return written;
}

/**
 * Build the catalog object — the single-source-of-truth machine-readable view
 * of every adapter command. Embeds the same fields agents need to decide which
 * command to call: name, description, when_to_use, columns, args, auth state.
 */
export function buildCatalog(): {
  source: string;
  generated: string;
  total_sites: number;
  total_commands: number;
  adapters: Array<{
    site: string;
    type: string;
    description?: string;
    domain?: string;
    auth: boolean;
    strategy?: string;
    commands: Array<{
      name: string;
      description: string;
      when_to_use: string;
      command: string;
      columns?: string[];
      args?: Array<{
        name: string;
        type?: string;
        required: boolean;
        positional: boolean;
        description?: string;
      }>;
    }>;
  }>;
} {
  const adapters = getAllAdapters();
  let totalCommands = 0;
  const adapterRows = adapters.map((adapter) => {
    const commands = Object.entries(adapter.commands).map(([cmdName, cmd]) => {
      totalCommands++;
      const skill = buildSkillForCommand(adapter, cmdName, cmd);
      return {
        name: cmdName,
        description: skill.description,
        when_to_use: skill.whenToUse,
        command: skill.command,
        columns: cmd.columns,
        args: cmd.adapterArgs?.map((a) => ({
          name: a.name,
          type: a.type,
          required: a.required ?? false,
          positional: a.positional ?? false,
          description: a.description,
        })),
      };
    });
    return {
      site: adapter.name,
      type: adapter.type,
      description: adapter.description,
      domain: adapter.domain,
      auth: adapter.strategy !== undefined && adapter.strategy !== "public",
      strategy: adapter.strategy,
      commands,
    };
  });

  return {
    source: `unicli@${VERSION}`,
    generated: new Date().toISOString(),
    total_sites: adapterRows.length,
    total_commands: totalCommands,
    adapters: adapterRows,
  };
}

/**
 * Trim a Skill down to a JSON-safe projection — we drop the raw frontmatter
 * to avoid dumping huge YAML blobs into the listing, and we normalize the
 * path into repo-relative form so the output is reproducible across machines.
 */
function projectSkillForJson(skill: Skill): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    triggers: skill.triggers,
    depends_on: skill.dependsOn,
    allowed_tools: skill.allowedTools,
    source: skill.source,
    path: skill.path,
    has_pipeline: Array.isArray(skill.pipeline) && skill.pipeline.length > 0,
  };
}

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Export adapter capabilities as Anthropic SKILL.md files");

  skills
    .command("export")
    .description(
      "Generate one SKILL.md per adapter command into an output directory",
    )
    .option("--out <dir>", "Output directory", "skills")
    .action((opts: ExportOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("skills.export", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const outDir = resolve(opts.out ?? "skills");
      mkdirSync(outDir, { recursive: true });
      const written = exportSkills(outDir);

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format({ written, out: outDir }, undefined, fmt, ctx));
      console.error(
        chalk.dim(`\n  wrote ${written} SKILL.md file(s) to ${outDir}`),
      );
    });

  skills
    .command("publish")
    .description(
      "Publish generated SKILL.md files into a Claude skills directory",
    )
    .option(
      "--to <dir>",
      "Target directory (default: ~/.claude/skills/uni-cli/)",
    )
    .action((opts: PublishOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("skills.publish", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const target = opts.to ?? join(homedir(), ".claude", "skills", "uni-cli");
      const resolved = resolve(target.replace(/^~(?=$|\/)/, homedir()));
      mkdirSync(resolved, { recursive: true });
      const written = exportSkills(resolved);

      ctx.duration_ms = Date.now() - startedAt;
      console.log(format({ written, to: resolved }, undefined, fmt, ctx));
      console.error(
        chalk.dim(`\n  published ${written} SKILL.md file(s) to ${resolved}`),
      );
    });

  skills
    .command("list")
    .description(
      "List cross-vendor SKILL.md files discovered in repo/user/XDG dirs",
    )
    .action(() => {
      const startedAt = Date.now();
      const ctx = makeCtx("skills.list", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const discovered = loadSkills();
      const rows = discovered.map(projectSkillForJson);

      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(rows, ["name", "description", "source", "path"], fmt, ctx),
      );

      if (discovered.length === 0) {
        console.error(chalk.dim("\n  No SKILL.md files found."));
      } else {
        console.error(chalk.dim(`\n  ${discovered.length} skill(s) total`));
      }
    });

  skills
    .command("invoke <name>")
    .description(
      "Invoke a skill: runs its inline pipeline if present, otherwise prints the body",
    )
    .action(async (name: string) => {
      const startedAt = Date.now();
      const ctx = makeCtx("skills.invoke", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const skill = loadSkills().find((s) => s.name === name);
      if (!skill) {
        ctx.error = {
          code: "not_found",
          message: `Unknown skill: ${name}`,
          suggestion: "Run `unicli skills list` to see options.",
          retryable: false,
        };
        ctx.duration_ms = Date.now() - startedAt;
        console.error(format(null, undefined, fmt, ctx));
        process.exit(ExitCode.USAGE_ERROR);
      }
      if (skill.pipeline && skill.pipeline.length > 0) {
        try {
          const results = await runPipeline(
            skill.pipeline,
            { args: {}, source: "internal" },
            undefined,
            {
              site: `skill:${skill.name}`,
            },
          );
          ctx.duration_ms = Date.now() - startedAt;
          console.log(
            format(
              { skill: skill.name, results } as Record<string, unknown>,
              undefined,
              fmt,
              ctx,
            ),
          );
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.error = {
            code: errorTypeToCode(err),
            message,
            suggestion: `Inspect skill pipeline at ${skill.path}`,
            retryable: false,
          };
          ctx.duration_ms = Date.now() - startedAt;
          console.error(format(null, undefined, fmt, ctx));
          process.exit(mapErrorToExitCode(err));
        }
      }
      // No pipeline → return the body as envelope data so agents can follow it.
      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(
          { skill: skill.name, body: skill.body } as Record<string, unknown>,
          undefined,
          fmt,
          ctx,
        ),
      );
    });

  skills
    .command("catalog")
    .description("Build a JSON catalog of every adapter command")
    .option("--out <file>", "Output file", "docs/adapters-catalog.json")
    .action((opts: CatalogOptions) => {
      const startedAt = Date.now();
      const ctx = makeCtx("skills.catalog", startedAt);
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );

      const out = resolve(opts.out ?? "docs/adapters-catalog.json");
      const dirOf = out.replace(/\/[^/]+$/, "");
      mkdirSync(dirOf, { recursive: true });
      const catalog = buildCatalog();
      writeFileSync(out, JSON.stringify(catalog, null, 2), "utf-8");

      ctx.duration_ms = Date.now() - startedAt;
      console.log(
        format(
          {
            out,
            total_sites: catalog.total_sites,
            total_commands: catalog.total_commands,
          },
          undefined,
          fmt,
          ctx,
        ),
      );
      console.error(
        chalk.dim(
          `\n  wrote catalog (${catalog.total_sites} sites, ${catalog.total_commands} commands) to ${out}`,
        ),
      );
    });
}
