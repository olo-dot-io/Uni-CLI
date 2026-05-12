/**
 * @owner   bench/surface-coverage.ts
 * @does    Compare Uni-CLI active command coverage against the synced surface reference and tracked signal cases.
 * @needs   dist/manifest.json, ref/reference/cli-manifest.json, optional src/adapters/_archived/archive.json
 * @feeds   tests/unit/surface-coverage.test.ts, npm run bench:surface-coverage, roadmap coverage evidence
 * @breaks  Missing active commands, stale reference manifests, or untracked archive exclusions skew parity reporting.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(HERE, "..");

export interface CommandSurface {
  source: string;
  sites: number;
  commands: number;
  site_counts: Record<string, number>;
  command_keys: string[];
}

export interface SignalCase {
  id: string;
  title: string;
  url?: string;
  source_version?: string;
  source_kind?: "release" | "pr" | "issue" | "fix";
  required_sites?: string[];
  required_commands?: string[];
  required_files?: string[];
  required_text?: Array<{
    file: string;
    includes: string;
    label?: string;
  }>;
}

export interface SignalCoverage extends SignalCase {
  status: "covered" | "missing";
  missing_sites: string[];
  missing_commands: string[];
  missing_files: string[];
  missing_text: string[];
}

export type CommandParityStatus =
  | "implemented"
  | "equivalent"
  | "strict-superset"
  | "missing";

export interface CommandParityEvidence {
  kind: "uni-command" | "mapping" | "archived-command" | "evidence-file";
  command?: string;
  file?: string;
  rationale?: string;
}

export interface CommandParityMapping {
  reference_command: string;
  status: "equivalent" | "strict-superset";
  uni_command?: string;
  evidence_files?: string[];
  rationale: string;
}

export interface CommandParityEntry {
  reference_command: string;
  reference_site: string;
  reference_name: string;
  status: CommandParityStatus;
  evidence: CommandParityEvidence[];
}

export interface CommandParityLedger {
  summary: Record<CommandParityStatus, number>;
  functional_command_coverage: number;
  unclassified_commands: string[];
  commands: CommandParityEntry[];
}

export interface SurfaceCoverageReport {
  generated_at: string;
  uni: Omit<CommandSurface, "command_keys">;
  reference: Omit<CommandSurface, "command_keys"> & {
    git?: {
      commit: string;
      subject: string;
      author_date: string;
    };
  };
  coverage: {
    site_coverage: number;
    command_coverage: number;
    missing_sites: number;
    missing_commands: number;
    archived_sites: number;
    archived_commands: number;
    extra_sites: number;
    extra_commands: number;
  };
  missing: {
    sites: string[];
    commands: string[];
  };
  archived: {
    source?: string;
    sites: string[];
    commands: string[];
  };
  extra: {
    sites: string[];
    commands: string[];
  };
  ledger: CommandParityLedger;
  signals: SignalCoverage[];
}

export const DEFAULT_SURFACE_SIGNALS: SignalCase[] = [
  {
    id: "surface-v1.7.18-reddit-account-and-thread-actions",
    title: "feat(reddit): add whoami, home, subreddit-info, and reply commands",
    source_version: "v1.7.18",
    source_kind: "release",
    required_commands: [
      "reddit/whoami",
      "reddit/home",
      "reddit/subreddit-info",
      "reddit/reply",
    ],
  },
  {
    id: "surface-v1.7.18-rednote-read-surface",
    title: "feat(rednote): add Rednote browser read/search surface",
    source_version: "v1.7.18",
    source_kind: "release",
    required_sites: ["rednote"],
    required_commands: [
      "rednote/comments",
      "rednote/download",
      "rednote/feed",
      "rednote/note",
      "rednote/notifications",
      "rednote/search",
      "rednote/user",
    ],
  },
  {
    id: "surface-v1.7.17-research-and-registry-sources",
    title:
      "feat: add OpenAlex, PubMed, OSV, NVD, DockerHub, crates, and goproxy sources",
    source_version: "v1.7.17",
    source_kind: "release",
    required_sites: [
      "openalex",
      "pubmed",
      "osv",
      "nvd",
      "dockerhub",
      "crates",
      "goproxy",
    ],
  },
  {
    id: "surface-v1.7.16-browser-agent-runtime",
    title:
      "feat(browser): agent-browser AX refs, semantic locators, native input, iframe routing, and annotated screenshots",
    source_version: "v1.7.16",
    source_kind: "release",
    required_text: [
      {
        file: "src/browser/snapshot.ts",
        includes: "data-unicli-ref",
        label: "browser snapshot emits refs",
      },
      {
        file: "src/browser/cdp-client.ts",
        includes: "iframe",
        label: "CDP client has iframe-aware logic",
      },
      {
        file: "tests/unit/browser/target-errors.test.ts",
        includes: "data-unicli-ref",
        label: "ref-backed locator verification tests",
      },
    ],
  },
  {
    id: "surface-v1.7.15-persistent-browser-session-contract",
    title: "feat(browser): replace workspace reuse with persistent sessions",
    source_version: "v1.7.15",
    source_kind: "release",
    required_text: [
      {
        file: "src/engine/session/query.ts",
        includes: "browser_session_id",
      },
      {
        file: "src/engine/browser/session-lease.ts",
        includes: "browser_session_id",
      },
      {
        file: "tests/unit/browser-session-lease.test.ts",
        includes: "browser_session_id",
      },
    ],
  },
  {
    id: "surface-v1.7.14-structured-help",
    title:
      "feat(help): adapter, browser, daemon, plugin, and profile help surfaces",
    source_version: "v1.7.14",
    source_kind: "release",
    required_commands: ["codex/projects", "chatgpt/history"],
  },
  {
    id: "surface-v1.7.13-typed-error-hardening",
    title:
      "fix: typed errors, no silent clamps, no sentinel rows, and no silent empty arrays",
    source_version: "v1.7.13",
    source_kind: "release",
    required_text: [
      {
        file: "src/core/envelope.ts",
        includes: "code",
        label: "structured error code surface",
      },
      {
        file: "src/engine/harden.ts",
        includes: "structured",
        label: "engine hardening path",
      },
    ],
  },
  {
    id: "surface-pr-1195",
    title: "fix(browser): keep text/javascript API responses in network output",
    required_text: [
      {
        file: "tests/unit/commands/browser.test.ts",
        includes: "text/javascript",
      },
      {
        file: "src/browser/network-cache.ts",
        includes: "bodyMatchesNetworkFilter",
      },
    ],
  },
  {
    id: "surface-pr-1176",
    title:
      "feat(google-scholar): add cite/profile commands and fix search dedup",
    required_commands: [
      "google-scholar/search",
      "google-scholar/cite",
      "google-scholar/profile",
    ],
  },
  {
    id: "surface-issue-1192",
    title: "[Feature]: Instagram",
    required_sites: ["instagram"],
    required_commands: ["instagram/search", "instagram/profile"],
  },
  {
    id: "surface-issue-1189",
    title: "[autofix] doubao/ask: message reading broken after DOM restructure",
    required_commands: ["doubao/ask"],
  },
  {
    id: "surface-issue-1184",
    title: "web/read should preserve meaningful button text",
    required_commands: ["web/read"],
  },
  {
    id: "surface-pr-1193",
    title: "docs: plugin-side daemon spawn pattern",
    required_files: ["docs/PLUGIN.md"],
    required_text: [
      {
        file: "docs/PLUGIN.md",
        includes: "Plugin-side browser daemon spawn pattern",
      },
      { file: "docs/PLUGIN.md", includes: "UNICLI_DAEMON_PORT" },
      {
        file: "docs/PLUGIN.md",
        includes: "@zenalexa/unicli/browser/daemon",
      },
    ],
  },
  {
    id: "surface-pr-1187",
    title: "feat(browser): custom daemon ports for extension dashboard",
    required_text: [
      {
        file: "src/commands/browser/actions.ts",
        includes: "--daemon-port <port>",
      },
      { file: "src/browser/daemon-client.ts", includes: "UNICLI_DAEMON_PORT" },
      {
        file: "src/browser/daemon-client.ts",
        includes: "COMPAT_DAEMON_PORT_ENV",
      },
    ],
  },
  {
    id: "surface-pr-1182",
    title: "errors: classify CDP debugger-detach as transient",
    required_text: [
      { file: "src/browser/daemon-client.ts", includes: "debugger" },
      { file: "src/browser/daemon-client.ts", includes: "detach" },
    ],
  },
  {
    id: "surface-pr-1181",
    title: "feat(browser): add upload command and fix producthunt hot",
    required_commands: ["producthunt/hot"],
    required_text: [
      {
        file: "src/commands/browser/actions.ts",
        includes: '.command("upload <ref> <path>")',
      },
      { file: "src/commands/browser/actions.ts", includes: "setFileInput" },
    ],
  },
  {
    id: "surface-issue-1169",
    title: "browser bind-current runtime contract",
    required_text: [
      { file: "src/browser/protocol.ts", includes: '"bind-current"' },
      { file: "src/browser/daemon-client.ts", includes: "bindCurrentTab" },
      { file: "src/commands/browser/index.ts", includes: '.command("bind")' },
    ],
  },
  {
    id: "surface-issue-1167",
    title: "DeepSeek file upload should not fail silently",
    required_text: [
      { file: "src/adapters/deepseek/web.ts", includes: 'name: "file"' },
      { file: "src/adapters/deepseek/web.ts", includes: "setFileInput" },
    ],
  },
  {
    id: "surface-issue-1161",
    title: "Dash-prefixed positional args should stay positional",
    required_text: [
      {
        file: "src/commands/dispatch.ts",
        includes: "allowsDashPrefixedPositionals",
      },
      {
        file: "tests/unit/fast-path.test.ts",
        includes: "dash-prefixed positional",
      },
    ],
  },
  {
    id: "surface-issue-1120",
    title: "browser network detail should expose captured requests",
    required_text: [
      {
        file: "src/commands/browser/authoring.ts",
        includes: "--detail <key>",
      },
      {
        file: "src/browser/network-cache.ts",
        includes: "findNetworkCacheEntry",
      },
    ],
  },
];

function commandKey(site: string, command: string): string {
  return `${site}/${command}`;
}

function splitCommandKey(key: string): [string, string] {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    throw new Error(`invalid command key: ${key}`);
  }
  return [key.slice(0, slash), key.slice(slash + 1)];
}

function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function toSurface(
  source: string,
  pairs: Array<[string, string]>,
): CommandSurface {
  const siteCounts: Record<string, number> = {};
  const commandKeys = new Set<string>();

  for (const [site, command] of pairs) {
    if (!site || !command) continue;
    siteCounts[site] = (siteCounts[site] ?? 0) + 1;
    commandKeys.add(commandKey(site, command));
  }

  return {
    source,
    sites: Object.keys(siteCounts).length,
    commands: commandKeys.size,
    site_counts: Object.fromEntries(
      Object.entries(siteCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    command_keys: [...commandKeys].sort(),
  };
}

export function readUniSurface(repoRoot: string): CommandSurface {
  const manifestPath = join(repoRoot, "dist", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`missing Uni-CLI manifest: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    sites?: Record<string, { commands?: Array<{ name?: string }> }>;
  };
  const pairs: Array<[string, string]> = [];
  for (const [site, info] of Object.entries(manifest.sites ?? {})) {
    for (const command of info.commands ?? []) {
      if (command.name) pairs.push([site, command.name]);
    }
  }
  return toSurface(manifestPath, pairs);
}

export function readReferenceSurface(repoRoot: string): CommandSurface {
  const manifestPath = join(repoRoot, "ref", "reference", "cli-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`missing surface reference manifest: ${manifestPath}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Array<{
    site?: string;
    name?: string;
  }>;
  return toSurface(
    manifestPath,
    manifest.flatMap((entry) =>
      entry.site && entry.name ? ([[entry.site, entry.name]] as const) : [],
    ),
  );
}

export function readArchivedSurface(repoRoot: string): CommandSurface {
  const archivePath = join(
    repoRoot,
    "src",
    "adapters",
    "_archived",
    "archive.json",
  );
  if (!existsSync(archivePath)) {
    return toSurface(archivePath, []);
  }

  const archive = JSON.parse(readFileSync(archivePath, "utf-8")) as {
    sites?: Array<{ site?: string; commands?: string[] }>;
  };
  const pairs: Array<[string, string]> = [];
  for (const record of archive.sites ?? []) {
    if (!record.site) continue;
    for (const command of record.commands ?? []) {
      pairs.push([record.site, command]);
    }
  }
  return toSurface(archivePath, pairs);
}

function readReferenceGit(
  repoRoot: string,
): SurfaceCoverageReport["reference"]["git"] {
  const refRoot = join(repoRoot, "ref", "reference");
  if (!existsSync(join(refRoot, ".git"))) return undefined;
  const res = spawnSync(
    "git",
    ["-C", refRoot, "log", "-1", "--pretty=format:%H%x00%aI%x00%s"],
    { encoding: "utf-8" },
  );
  if (res.status !== 0) return undefined;
  const [commit, authorDate, subject] = res.stdout.split("\0");
  if (!commit || !authorDate || !subject) return undefined;
  return { commit, author_date: authorDate, subject };
}

export function evaluateSignalCoverage(
  uni: CommandSurface,
  signals: SignalCase[],
  repoRoot = DEFAULT_REPO_ROOT,
): SignalCoverage[] {
  const sites = new Set(Object.keys(uni.site_counts));
  const commands = new Set(uni.command_keys);

  return signals.map((signal) => {
    const missingSites = (signal.required_sites ?? []).filter(
      (site) => !sites.has(site),
    );
    const missingCommands = (signal.required_commands ?? []).filter(
      (command) => !commands.has(command),
    );
    const missingFiles = (signal.required_files ?? []).filter(
      (file) => !existsSync(join(repoRoot, file)),
    );
    const missingText = (signal.required_text ?? [])
      .filter((requirement) => {
        const filePath = join(repoRoot, requirement.file);
        if (!existsSync(filePath)) return true;
        return !readFileSync(filePath, "utf-8").includes(requirement.includes);
      })
      .map(
        (requirement) =>
          requirement.label ??
          `${requirement.file}: ${JSON.stringify(requirement.includes)}`,
      );
    return {
      ...signal,
      status:
        missingSites.length === 0 &&
        missingCommands.length === 0 &&
        missingFiles.length === 0 &&
        missingText.length === 0
          ? "covered"
          : "missing",
      missing_sites: missingSites,
      missing_commands: missingCommands,
      missing_files: missingFiles,
      missing_text: missingText,
    };
  });
}

function validateCommandParityMappings(
  mappings: CommandParityMapping[],
): Map<string, CommandParityMapping> {
  const map = new Map<string, CommandParityMapping>();
  for (const mapping of mappings) {
    if (!mapping.reference_command) {
      throw new Error("command coverage mapping missing reference_command");
    }
    if (
      mapping.status !== "equivalent" &&
      mapping.status !== "strict-superset"
    ) {
      throw new Error(
        `invalid mapping status for ${mapping.reference_command}: ${mapping.status}`,
      );
    }
    if (!mapping.rationale.trim()) {
      throw new Error(
        `command coverage mapping missing rationale: ${mapping.reference_command}`,
      );
    }
    if (
      map.has(mapping.reference_command) &&
      JSON.stringify(map.get(mapping.reference_command)) !==
        JSON.stringify(mapping)
    ) {
      throw new Error(
        `duplicate command coverage mapping: ${mapping.reference_command}`,
      );
    }
    map.set(mapping.reference_command, mapping);
  }
  return map;
}

export function buildCommandParityLedger(
  reference: CommandSurface,
  uni: CommandSurface,
  archived: CommandSurface,
  mappings: CommandParityMapping[] = [],
): CommandParityLedger {
  const uniCommands = new Set(uni.command_keys);
  const archivedCommands = new Set(archived.command_keys);
  const mappingByCommand = validateCommandParityMappings(mappings);
  const summary: Record<CommandParityStatus, number> = {
    implemented: 0,
    equivalent: 0,
    "strict-superset": 0,
    missing: 0,
  };

  const commands = reference.command_keys.map((referenceCommand) => {
    const [referenceSite, referenceName] = splitCommandKey(referenceCommand);
    const mapping = mappingByCommand.get(referenceCommand);
    let status: CommandParityStatus = "missing";
    const evidence: CommandParityEvidence[] = [];

    if (uniCommands.has(referenceCommand)) {
      status = "implemented";
      evidence.push({ kind: "uni-command", command: referenceCommand });
    } else if (mapping) {
      status = mapping.status;
      evidence.push({
        kind: "mapping",
        command: mapping.uni_command,
        rationale: mapping.rationale,
      });
      for (const file of mapping.evidence_files ?? []) {
        evidence.push({ kind: "evidence-file", file });
      }
    } else if (archivedCommands.has(referenceCommand)) {
      evidence.push({ kind: "archived-command", command: referenceCommand });
    }

    summary[status] += 1;
    return {
      reference_command: referenceCommand,
      reference_site: referenceSite,
      reference_name: referenceName,
      status,
      evidence,
    };
  });

  const covered =
    summary.implemented + summary.equivalent + summary["strict-superset"];
  return {
    summary,
    functional_command_coverage: roundRatio(
      reference.commands === 0 ? 1 : covered / reference.commands,
    ),
    unclassified_commands: commands
      .filter((entry) => !entry.status)
      .map((entry) => entry.reference_command),
    commands,
  };
}

export function buildSurfaceCoverageReport(opts?: {
  repoRoot?: string;
  generatedAt?: string;
  signals?: SignalCase[];
  commandMappings?: CommandParityMapping[];
}): SurfaceCoverageReport {
  const repoRoot = opts?.repoRoot ?? DEFAULT_REPO_ROOT;
  const uni = readUniSurface(repoRoot);
  const reference = readReferenceSurface(repoRoot);
  const archived = readArchivedSurface(repoRoot);

  const uniSites = new Set(Object.keys(uni.site_counts));
  const referenceSites = new Set(Object.keys(reference.site_counts));
  const archivedSites = new Set(Object.keys(archived.site_counts));
  const uniCommands = new Set(uni.command_keys);
  const referenceCommands = new Set(reference.command_keys);
  const archivedCommands = new Set(archived.command_keys);
  const ledger = buildCommandParityLedger(
    reference,
    uni,
    archived,
    opts?.commandMappings,
  );

  const missingSites = [...referenceSites]
    .filter((site) => !uniSites.has(site))
    .sort();
  const missingCommands = ledger.commands
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.reference_command)
    .sort();
  const archivedReferenceSites = [...referenceSites]
    .filter((site) => archivedSites.has(site))
    .sort();
  const archivedReferenceCommands = [...referenceCommands]
    .filter((command) => archivedCommands.has(command))
    .sort();
  const extraSites = [...uniSites]
    .filter((site) => !referenceSites.has(site))
    .sort();
  const extraCommands = [...uniCommands]
    .filter((command) => !referenceCommands.has(command))
    .sort();

  const signals = evaluateSignalCoverage(
    uni,
    opts?.signals ?? DEFAULT_SURFACE_SIGNALS,
    repoRoot,
  );

  return {
    generated_at: opts?.generatedAt ?? new Date().toISOString(),
    uni: {
      source: uni.source,
      sites: uni.sites,
      commands: uni.commands,
      site_counts: uni.site_counts,
    },
    reference: {
      source: reference.source,
      sites: reference.sites,
      commands: reference.commands,
      site_counts: reference.site_counts,
      git: readReferenceGit(repoRoot),
    },
    coverage: {
      site_coverage: roundRatio(
        reference.sites === 0
          ? 1
          : (reference.sites - missingSites.length) / reference.sites,
      ),
      command_coverage: roundRatio(
        reference.commands === 0
          ? 1
          : (reference.commands - ledger.summary.missing) / reference.commands,
      ),
      missing_sites: missingSites.length,
      missing_commands: missingCommands.length,
      archived_sites: archivedReferenceSites.length,
      archived_commands: archivedReferenceCommands.length,
      extra_sites: extraSites.length,
      extra_commands: extraCommands.length,
    },
    missing: {
      sites: missingSites,
      commands: missingCommands,
    },
    archived: {
      source: existsSync(archived.source) ? archived.source : undefined,
      sites: archivedReferenceSites,
      commands: archivedReferenceCommands,
    },
    extra: {
      sites: extraSites,
      commands: extraCommands,
    },
    ledger,
    signals,
  };
}

function readSignalsFile(path: string): SignalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`signals file must contain an array: ${path}`);
  }
  return parsed as SignalCase[];
}

function parseArgs(argv: string[]): {
  repoRoot: string;
  signals?: SignalCase[];
  commandMappings?: CommandParityMapping[];
  failOnGaps: boolean;
} {
  let repoRoot = DEFAULT_REPO_ROOT;
  let signals: SignalCase[] | undefined;
  let commandMappings: CommandParityMapping[] | undefined;
  let failOnGaps = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--repo-root") {
      repoRoot = argv[++i] ?? repoRoot;
      continue;
    }
    if (arg === "--signals") {
      const path = argv[++i];
      if (!path) throw new Error("--signals requires a file path");
      signals = readSignalsFile(path);
      continue;
    }
    if (arg === "--mappings") {
      const path = argv[++i];
      if (!path) throw new Error("--mappings requires a file path");
      commandMappings = readMappingsFile(path);
      continue;
    }
    if (arg === "--fail-on-gaps") {
      failOnGaps = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "Usage: npm run bench:surface-coverage -- [--repo-root <path>] [--signals <json>] [--mappings <json>] [--fail-on-gaps]",
          "",
          "Outputs a JSON report comparing dist/manifest.json with ref/reference/cli-manifest.json.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { repoRoot, signals, commandMappings, failOnGaps };
}

function readMappingsFile(path: string): CommandParityMapping[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`mappings file must contain an array: ${path}`);
  }
  return parsed as CommandParityMapping[];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildSurfaceCoverageReport({
      repoRoot: args.repoRoot,
      signals: args.signals,
      commandMappings: args.commandMappings,
    });
    console.log(JSON.stringify(report, null, 2));
    const missingSignal = report.signals.some(
      (signal) => signal.status === "missing",
    );
    if (
      args.failOnGaps &&
      (report.coverage.missing_commands > 0 ||
        report.coverage.missing_sites > 0 ||
        missingSignal)
    ) {
      process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
