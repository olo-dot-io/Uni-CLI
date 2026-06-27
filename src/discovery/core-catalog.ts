/**
 * @owner   src/discovery/core-catalog.ts
 * @does    Catalog core Uni-CLI commands that are implemented by Commander modules instead of adapter manifests.
 * @needs   none
 * @feeds   src/discovery/search.ts, src/fast-path/handlers/discovery.ts, src/mcp/handler.ts, src/cli.ts
 * @breaks  Missing core rows make built-in capabilities executable but undiscoverable through search/list/MCP.
 */

import type { TargetSurface } from "../types.js";
import {
  getComputeCommandContract,
  type ComputeCommandArg,
} from "../compute/contracts.js";

export interface CoreDiscoveryArg {
  name: string;
  type?: "str" | "int" | "float" | "bool";
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
}

export interface CoreDiscoveryCommand {
  site: string;
  command: string;
  description: string;
  category: string;
  type: string;
  target_surface?: TargetSurface;
  source_path?: string;
  args?: readonly CoreDiscoveryArg[];
  channels?: Record<string, string>;
  capabilities?: readonly string[];
  minimum_capability?: string;
}

const CORE_COMMAND_SOURCE_PATHS: Record<string, string> = {
  agents: "src/commands/agents.ts",
  architecture: "src/commands/architecture.ts",
  browser: "src/commands/browser/index.ts",
  compute: "src/commands/compute.ts",
  delivery: "src/commands/delivery.ts",
  mcp: "src/commands/mcp.ts",
  operate: "src/commands/operate.ts",
  runs: "src/commands/runs.ts",
  scholar: "src/commands/scholar.ts",
};

const CORE_DISCOVERY_COMMANDS: readonly CoreDiscoveryCommand[] = [
  {
    site: "scholar",
    command: "availability",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Audit one academic paper from DOI, arXiv id, PMID, OpenReview id, source-local id, or title, then report source-backed metadata, PDF, full-text, code, dataset/model, citation, reference, and review availability plus next commands without downloading artifacts.",
    capabilities: [
      "http.fetch",
      "scholar.get",
      "scholar.pdf",
      "scholar.fulltext",
      "scholar.code",
      "scholar.datasets",
      "scholar.citations",
      "scholar.references",
      "scholar.review",
    ],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include evidence URLs, errors, and next commands",
      },
    ],
  },
  {
    site: "scholar",
    command: "evidence",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Classify one academic paper's source-backed evidence from DOI, arXiv id, PMID, OpenReview id, source-local id, or title into citation safety, reading readiness, missing evidence, primary anchors, and next commands without downloading artifacts.",
    capabilities: [
      "http.fetch",
      "scholar.get",
      "scholar.pdf",
      "scholar.fulltext",
      "scholar.code",
      "scholar.datasets",
      "scholar.citations",
      "scholar.references",
      "scholar.review",
    ],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include source errors and command timestamp",
      },
    ],
  },
  {
    site: "scholar",
    command: "sources",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Show a per-source provenance matrix for one academic paper from DOI, arXiv id, PMID, OpenReview id, source-local id, or title, including source status, evidence types, candidate capabilities, next commands, and source errors without downloading artifacts.",
    capabilities: [
      "http.fetch",
      "scholar.get",
      "scholar.pdf",
      "scholar.fulltext",
      "scholar.code",
      "scholar.datasets",
      "scholar.citations",
      "scholar.references",
      "scholar.review",
    ],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include source capabilities, errors, and next commands",
      },
    ],
  },
  {
    site: "scholar",
    command: "workflow",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Build a source-backed agent runbook for one academic paper from DOI, arXiv id, PMID, OpenReview id, source-local id, or title, ordering evidence classification, source reading, artifact download, citation/reference graph audit, peer-review audit, and reproducibility planning without downloading, cloning, installing, executing, or summarizing claims.",
    capabilities: [
      "http.fetch",
      "scholar.get",
      "scholar.pdf",
      "scholar.fulltext",
      "scholar.code",
      "scholar.datasets",
      "scholar.citations",
      "scholar.references",
      "scholar.review",
    ],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include runbook steps, source errors, and timestamp",
      },
    ],
  },
  {
    site: "scholar",
    command: "reproduce",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Plan one academic paper's source-backed code, data, model, and Space reproducibility path from DOI, arXiv id, OpenReview id, source-local id, or title, including installation readiness and safety boundaries without cloning, installing, or executing remote code.",
    capabilities: [
      "http.fetch",
      "scholar.get",
      "scholar.pdf",
      "scholar.fulltext",
      "scholar.code",
      "scholar.datasets",
    ],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include source errors, download command, and timestamp",
      },
    ],
  },
  {
    site: "scholar",
    command: "coverage",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Compare registered academic and scholarly sources by discovery, metadata, PDF, full-text, code, dataset/model, citation, reference, and review coverage, then report missing closed-loop capabilities and next commands for agent routing without network I/O.",
    capabilities: [
      "scholar.search",
      "scholar.get",
      "scholar.pdf",
      "scholar.fulltext",
      "scholar.code",
      "scholar.datasets",
      "scholar.citations",
      "scholar.references",
      "scholar.review",
      "scholar.venue",
      "scholar.author",
    ],
    args: [
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "gaps",
        type: "bool",
        description: "Show only sources with missing closed-loop capabilities",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include source command names and next commands",
      },
    ],
  },
  {
    site: "scholar",
    command: "reviews",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Fetch source-backed peer-review, decision, rebuttal, and comment rows for a scholarly paper review thread such as an OpenReview forum, with note ids, source URLs, ratings, confidence, text truncation, and agent-auditable anchors.",
    capabilities: ["http.fetch", "scholar.review"],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "OpenReview forum id, forum URL, or review-thread id",
      },
      {
        name: "source",
        type: "str",
        description: "Force one review-capable source",
      },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated review-capable sources, or all",
      },
      {
        name: "max-length",
        type: "int",
        default: 4000,
        description: "Per-row review text truncation length",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include reviewer/signature and text size fields",
      },
    ],
  },
  {
    site: "scholar",
    command: "code",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve an academic paper from DOI, arXiv id, OpenReview id, source-local id, or title across scholarly resource-capable adapters, then return linked code repositories and project pages.",
    capabilities: ["http.fetch", "scholar.code"],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include richer resource metadata columns",
      },
    ],
  },
  {
    site: "scholar",
    command: "datasets",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve an academic paper from DOI, arXiv id, OpenReview id, source-local id, or title across scholarly resource-capable adapters, then return linked datasets, models, and Spaces.",
    capabilities: ["http.fetch", "scholar.datasets"],
    minimum_capability: "http.fetch",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "detailed",
        type: "bool",
        description: "Include richer resource metadata columns",
      },
    ],
  },
  {
    site: "scholar",
    command: "read",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve an academic paper from DOI, arXiv id, OpenReview id, PubMed id, source-local id, or title across scholarly sources, prefer source-direct full text, then download the open PDF and extract capped text for agent reading.",
    capabilities: [
      "http.fetch",
      "http.download",
      "subprocess.exec",
      "scholar.fulltext",
      "scholar.pdf",
    ],
    minimum_capability: "subprocess.exec",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "venue",
        type: "str",
        description: "Source-local venue scope, e.g. CVPR or ICCV",
      },
      {
        name: "year",
        type: "str",
        description: "Source-local proceedings year",
      },
      {
        name: "volume",
        type: "str",
        description: "Source-local proceedings volume, e.g. PMLR v235",
      },
      {
        name: "output",
        type: "str",
        default: "./scholar-downloads",
        description: "Output directory",
      },
      { name: "first-page", type: "int", default: 1 },
      { name: "last-page", type: "int", default: 20 },
      {
        name: "max-chars",
        type: "int",
        description: "Maximum extracted/read text characters",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
    ],
  },
  {
    site: "scholar",
    command: "download",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve an academic paper from DOI, arXiv id, OpenReview id, source-local id, or title across scholarly sources, download the open PDF, and return artifact metadata.",
    capabilities: ["http.download", "scholar.pdf"],
    minimum_capability: "http.download",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, arXiv id, OpenReview id, source-local id, or title",
      },
      { name: "source", type: "str", description: "Force one source" },
      {
        name: "sources",
        type: "str",
        description: "Comma-separated sources, or all",
      },
      {
        name: "venue",
        type: "str",
        description: "Source-local venue scope, e.g. CVPR or ICCV",
      },
      {
        name: "year",
        type: "str",
        description: "Source-local proceedings year",
      },
      {
        name: "volume",
        type: "str",
        description: "Source-local proceedings volume, e.g. PMLR v235",
      },
      {
        name: "output",
        type: "str",
        default: "./scholar-downloads",
        description: "Output directory",
      },
      {
        name: "unpaywall-email",
        type: "str",
        description: "Requester email for Unpaywall DOI lookup",
      },
    ],
  },
  {
    site: "browser",
    command: "evidence",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Capture browser operator evidence for web automation, website control, agent workflows, MCP/CLI debugging, DOM snapshots, screenshots, network summaries, render-aware observation, session leases, and audit trails.",
  },
  {
    site: "browser",
    command: "extract",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Extract rendered website text through the browser operator with render-aware waiting, session lease metadata, DOM evidence, and agent-friendly structured output.",
  },
  {
    site: "browser",
    command: "state",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Read the current browser page state, accessibility tree, refs, URL, and DOM snapshot for website control and agent browser automation.",
  },
  {
    site: "browser",
    command: "click",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Click a browser page ref with stale-ref checks, session lease ownership, action evidence, watchdog movement checks, and recorded run traces.",
  },
  {
    site: "browser",
    command: "bind",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Bind the current visible browser tab into a named workspace with domain and path guards for profile reuse and multi-command automation.",
  },
  {
    site: "operate",
    command: "state",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Inspect the current browser automation workspace for agent operation, website control, page refs, and accessibility tree state.",
  },
  {
    site: "operate",
    command: "click",
    category: "dev",
    type: "browser",
    target_surface: "web",
    description:
      "Operate a browser page by clicking refs with recorded evidence and session lease metadata.",
  },
  {
    site: "mcp",
    command: "serve",
    category: "dev",
    type: "service",
    description:
      "Serve Uni-CLI through MCP for agents, exposing command search, command run, browser/web capabilities, structured envelopes, and protocol integration.",
  },
  {
    site: "agents",
    command: "recommend",
    category: "dev",
    type: "service",
    description:
      "Recommend the right agent backend or CLI for a task, including Codex, Claude Code, OpenCode, MCP, ACP, browser, desktop, and tool workflows.",
  },
  {
    site: "runs",
    command: "list",
    category: "dev",
    type: "service",
    description:
      "List recorded Uni-CLI run traces, browser session leases, evidence events, watchdog outcomes, command status, and replay/index metadata.",
  },
  {
    site: "runs",
    command: "show",
    category: "dev",
    type: "service",
    description:
      "Show recorded run trace events for debugging, replay preparation, browser lease evidence, render stability, and agent audit review.",
  },
  {
    site: "runs",
    command: "probe",
    category: "dev",
    type: "service",
    description:
      "Probe a recorded run trace for exact replay readiness, private args availability, command metadata, and evidence-backed reproducibility.",
  },
  {
    site: "runs",
    command: "replay",
    category: "dev",
    type: "service",
    description:
      "Replay a recorded command through the native execution kernel, write a fresh replay trace, and gate behavior, context, or overall scores.",
  },
  {
    site: "runs",
    command: "compare",
    category: "dev",
    type: "service",
    description:
      "Compare two recorded run traces for behavior drift, context drift, score gates, result envelope differences, repair verification, and reproducible agent audit checks.",
  },
  {
    site: "delivery",
    command: "assess",
    category: "dev",
    type: "service",
    description:
      "Assess an objective delivery spec from recorded run evidence, classify failure state, and choose the next action for agent self-repair, retry, auth, permission, or stop.",
  },
  {
    site: "delivery",
    command: "run",
    category: "dev",
    type: "service",
    description:
      "Execute the next delivery experiment from an objective spec through the shared command kernel, record the new run trace, and return the updated trajectory.",
  },
  {
    site: "delivery",
    command: "trajectory",
    category: "dev",
    type: "service",
    description:
      "Build a reviewable objective trajectory from run evidence with failed gates, diagnosis, hypothesis, verification status, and the next executable experiment for closed-loop agents.",
  },
  {
    site: "delivery",
    command: "repair-candidate",
    category: "dev",
    type: "service",
    description:
      "Compile a delivery trajectory into one bounded adapter repair candidate with adapter path, diagnosis, verify command, and repair safety constraints.",
  },
  {
    site: "architecture",
    command: "tree",
    category: "dev",
    type: "service",
    description:
      "Emit Uni-CLI's callable computer-control architecture tree for agents, including operation contracts, control kernel, action substrates, evidence delivery, runtime exposure, internal authoring cycle, and verification roots.",
  },
  {
    site: "architecture",
    command: "audit",
    category: "dev",
    type: "service",
    description:
      "Audit Uni-CLI computer-control readiness before restructuring, including command counts, local computer-use coverage, control stages, missing source paths, substrate identity boundaries, and full rewrite readiness.",
  },
  {
    site: "compute",
    command: "apps",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("apps"),
  },
  {
    site: "compute",
    command: "windows",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("windows"),
  },
  {
    site: "compute",
    command: "snapshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("snapshot"),
  },
  {
    site: "compute",
    command: "capture",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("capture"),
  },
  {
    site: "compute",
    command: "find",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("find"),
  },
  {
    site: "compute",
    command: "click",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("click"),
  },
  {
    site: "compute",
    command: "type",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("type"),
  },
  {
    site: "compute",
    command: "press",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("press"),
  },
  {
    site: "compute",
    command: "scroll",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("scroll"),
  },
  {
    site: "compute",
    command: "launch",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("launch"),
  },
  {
    site: "compute",
    command: "screenshot",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("screenshot"),
  },
  {
    site: "compute",
    command: "attach",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("attach"),
  },
  {
    site: "compute",
    command: "eval",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("eval"),
  },
  {
    site: "compute",
    command: "wait",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("wait"),
  },
  {
    site: "compute",
    command: "observe",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("observe"),
  },
  {
    site: "compute",
    command: "assert",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("assert"),
  },
];

export function listCoreDiscoveryCommands(): CoreDiscoveryCommand[] {
  return CORE_DISCOVERY_COMMANDS.map(withCoreSourcePath).sort(
    (a, b) =>
      a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
  );
}

export function getCoreDiscoveryCommand(
  site: string,
  command: string,
): CoreDiscoveryCommand | undefined {
  const coreCommand = CORE_DISCOVERY_COMMANDS.find(
    (candidate) => candidate.site === site && candidate.command === command,
  );
  return coreCommand ? withCoreSourcePath(coreCommand) : undefined;
}

export function listCoreDiscoverySites(): Array<{
  site: string;
  category: string;
  type: string;
  commands: CoreDiscoveryCommand[];
}> {
  const sites = new Map<
    string,
    { category: string; type: string; commands: CoreDiscoveryCommand[] }
  >();
  for (const command of CORE_DISCOVERY_COMMANDS.map(withCoreSourcePath)) {
    const entry = sites.get(command.site) ?? {
      category: command.category,
      type: command.type,
      commands: [],
    };
    entry.commands.push(command);
    sites.set(command.site, entry);
  }
  return Array.from(sites.entries())
    .map(([site, info]) => ({
      site,
      category: info.category,
      type: info.type,
      commands: [...info.commands].sort((a, b) =>
        a.command.localeCompare(b.command),
      ),
    }))
    .sort((a, b) => a.site.localeCompare(b.site));
}

export function coreDiscoveryCategory(site: string): string | undefined {
  return CORE_DISCOVERY_COMMANDS.find((command) => command.site === site)
    ?.category;
}

function withCoreSourcePath(
  command: CoreDiscoveryCommand,
): CoreDiscoveryCommand {
  return {
    ...command,
    source_path: command.source_path ?? CORE_COMMAND_SOURCE_PATHS[command.site],
  };
}

function computeCommandFields(
  command: string,
): Pick<CoreDiscoveryCommand, "args" | "channels" | "description"> {
  const contract = getComputeCommandContract(command);
  if (!contract) {
    throw new Error(`missing compute command contract for ${command}`);
  }
  return {
    description: contract.description,
    args: contract.args.map(toCoreDiscoveryArg),
    ...(contract.channels ? { channels: contract.channels } : {}),
  };
}

function toCoreDiscoveryArg(arg: ComputeCommandArg): CoreDiscoveryArg {
  return {
    name: arg.name,
    ...(arg.type === undefined ? {} : { type: arg.type }),
    ...(arg.default === undefined ? {} : { default: arg.default }),
    ...(arg.required === undefined ? {} : { required: arg.required }),
    ...(arg.positional === undefined ? {} : { positional: arg.positional }),
    ...(arg.choices === undefined ? {} : { choices: [...arg.choices] }),
    ...(arg.description === undefined ? {} : { description: arg.description }),
  };
}
