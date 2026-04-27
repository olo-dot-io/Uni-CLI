/**
 * opencli-parity.ts — quantitative comparison against the synced OpenCLI ref.
 *
 * Default mode is offline and deterministic:
 *   Uni-CLI:  dist/manifest.json
 *   OpenCLI: ref/opencli/cli-manifest.json
 *
 * It also evaluates a small set of public OpenCLI PR/issue signals captured
 * from GitHub so current competitor movement becomes a measurable watchlist
 * instead of a prose note.
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

export interface OpenCliParityReport {
  generated_at: string;
  uni: Omit<CommandSurface, "command_keys">;
  opencli: Omit<CommandSurface, "command_keys"> & {
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
    extra_sites: number;
    extra_commands: number;
  };
  missing: {
    sites: string[];
    commands: string[];
  };
  extra: {
    sites: string[];
    commands: string[];
  };
  signals: SignalCoverage[];
}

export const DEFAULT_OPENCLI_SIGNALS: SignalCase[] = [
  {
    id: "opencli-pr-1195",
    title: "fix(browser): keep text/javascript API responses in network output",
    url: "https://github.com/jackwener/OpenCLI/pull/1195",
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
    id: "opencli-pr-1176",
    title:
      "feat(google-scholar): add cite/profile commands and fix search dedup",
    url: "https://github.com/jackwener/OpenCLI/pull/1176",
    required_commands: [
      "google-scholar/search",
      "google-scholar/cite",
      "google-scholar/profile",
    ],
  },
  {
    id: "opencli-issue-1192",
    title: "[Feature]: Instagram",
    url: "https://github.com/jackwener/OpenCLI/issues/1192",
    required_sites: ["instagram"],
    required_commands: ["instagram/search", "instagram/profile"],
  },
  {
    id: "opencli-issue-1189",
    title: "[autofix] doubao/ask: message reading broken after DOM restructure",
    url: "https://github.com/jackwener/OpenCLI/issues/1189",
    required_commands: ["doubao/ask"],
  },
  {
    id: "opencli-issue-1184",
    title: "web/read should preserve meaningful button text",
    url: "https://github.com/jackwener/OpenCLI/issues/1184",
    required_commands: ["web/read"],
  },
  {
    id: "opencli-pr-1193",
    title: "docs: plugin-side daemon spawn pattern",
    url: "https://github.com/jackwener/OpenCLI/pull/1193",
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
    id: "opencli-pr-1187",
    title: "feat(browser): custom daemon ports for extension dashboard",
    url: "https://github.com/jackwener/OpenCLI/pull/1187",
    required_text: [
      {
        file: "src/commands/browser-operator.ts",
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
    id: "opencli-pr-1182",
    title: "errors: classify CDP debugger-detach as transient",
    url: "https://github.com/jackwener/OpenCLI/pull/1182",
    required_text: [
      { file: "src/browser/daemon-client.ts", includes: "debugger" },
      { file: "src/browser/daemon-client.ts", includes: "detach" },
    ],
  },
  {
    id: "opencli-pr-1181",
    title: "feat(browser): add upload command and fix producthunt hot",
    url: "https://github.com/jackwener/OpenCLI/pull/1181",
    required_commands: ["producthunt/hot"],
    required_text: [
      {
        file: "src/commands/browser-operator.ts",
        includes: '.command("upload <ref> <path>")',
      },
      { file: "src/commands/browser-operator.ts", includes: "setFileInput" },
    ],
  },
  {
    id: "opencli-issue-1169",
    title: "browser bind-current runtime contract",
    url: "https://github.com/jackwener/OpenCLI/issues/1169",
    required_text: [
      { file: "src/browser/protocol.ts", includes: '"bind-current"' },
      { file: "src/browser/daemon-client.ts", includes: "bindCurrentTab" },
      { file: "src/commands/browser.ts", includes: '.command("bind")' },
    ],
  },
  {
    id: "opencli-issue-1167",
    title: "DeepSeek file upload should not fail silently",
    url: "https://github.com/jackwener/OpenCLI/issues/1167",
    required_text: [
      { file: "src/adapters/deepseek/web.ts", includes: 'name: "file"' },
      { file: "src/adapters/deepseek/web.ts", includes: "setFileInput" },
    ],
  },
  {
    id: "opencli-issue-1161",
    title: "Dash-prefixed positional args should stay positional",
    url: "https://github.com/jackwener/OpenCLI/issues/1161",
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
    id: "opencli-issue-1120",
    title: "browser network detail should expose captured requests",
    url: "https://github.com/jackwener/OpenCLI/issues/1120",
    required_text: [
      {
        file: "src/commands/browser-authoring-operator.ts",
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

export function readOpenCliSurface(repoRoot: string): CommandSurface {
  const manifestPath = join(repoRoot, "ref", "opencli", "cli-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`missing OpenCLI reference manifest: ${manifestPath}`);
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

function readOpenCliGit(
  repoRoot: string,
): OpenCliParityReport["opencli"]["git"] {
  const refRoot = join(repoRoot, "ref", "opencli");
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

export function buildOpenCliParityReport(opts?: {
  repoRoot?: string;
  generatedAt?: string;
  signals?: SignalCase[];
}): OpenCliParityReport {
  const repoRoot = opts?.repoRoot ?? DEFAULT_REPO_ROOT;
  const uni = readUniSurface(repoRoot);
  const opencli = readOpenCliSurface(repoRoot);

  const uniSites = new Set(Object.keys(uni.site_counts));
  const opencliSites = new Set(Object.keys(opencli.site_counts));
  const uniCommands = new Set(uni.command_keys);
  const opencliCommands = new Set(opencli.command_keys);

  const missingSites = [...opencliSites]
    .filter((site) => !uniSites.has(site))
    .sort();
  const missingCommands = [...opencliCommands]
    .filter((command) => !uniCommands.has(command))
    .sort();
  const extraSites = [...uniSites]
    .filter((site) => !opencliSites.has(site))
    .sort();
  const extraCommands = [...uniCommands]
    .filter((command) => !opencliCommands.has(command))
    .sort();

  const signals = evaluateSignalCoverage(
    uni,
    opts?.signals ?? DEFAULT_OPENCLI_SIGNALS,
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
    opencli: {
      source: opencli.source,
      sites: opencli.sites,
      commands: opencli.commands,
      site_counts: opencli.site_counts,
      git: readOpenCliGit(repoRoot),
    },
    coverage: {
      site_coverage: roundRatio(
        opencli.sites === 0
          ? 1
          : (opencli.sites - missingSites.length) / opencli.sites,
      ),
      command_coverage: roundRatio(
        opencli.commands === 0
          ? 1
          : (opencli.commands - missingCommands.length) / opencli.commands,
      ),
      missing_sites: missingSites.length,
      missing_commands: missingCommands.length,
      extra_sites: extraSites.length,
      extra_commands: extraCommands.length,
    },
    missing: {
      sites: missingSites,
      commands: missingCommands,
    },
    extra: {
      sites: extraSites,
      commands: extraCommands,
    },
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
  failOnGaps: boolean;
} {
  let repoRoot = DEFAULT_REPO_ROOT;
  let signals: SignalCase[] | undefined;
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
    if (arg === "--fail-on-gaps") {
      failOnGaps = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(
        [
          "Usage: pnpm bench:opencli-parity [--repo-root <path>] [--signals <json>] [--fail-on-gaps]",
          "",
          "Outputs a JSON report comparing dist/manifest.json with ref/opencli/cli-manifest.json.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { repoRoot, signals, failOnGaps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildOpenCliParityReport({
      repoRoot: args.repoRoot,
      signals: args.signals,
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
