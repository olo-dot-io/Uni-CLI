/**
 * @owner   src/discovery/core-catalog.ts
 * @does    Catalog core Uni-CLI commands that are implemented by Commander modules instead of adapter manifests.
 * @needs   src/types.ts, src/compute/contracts.ts
 * @feeds   src/discovery/search.ts, src/fast-path/handlers/discovery.ts, src/mcp/handler.ts, src/commands/{architecture,describe,schema}.ts, src/core/{architecture-tree,command-contract}.ts, src/cli.ts
 * @breaks  Throws during module initialization when a listed compute command has no owned contract; missing rows make built-in capabilities undiscoverable.
 * @invariants Each core command has one site/command identity and list APIs return deterministic lexical order with an owned source path when available.
 * @side-effects none
 * @perf Immutable indexes are compiled once; point/category lookup is average O(1), full listing is O(n) output construction.
 * @concurrency Pure reads over immutable module data; list and lookup APIs return new top-level row objects.
 * @test tests/unit/command-contract.test.ts, tests/unit/commands/architecture.test.ts
 * @stability stable
 * @since 2026-05-25
 */

import type {
  AdapterArg,
  AdapterCommand,
  ExecutionOperator,
  OperationEffect,
  OperationFamily,
  TargetSurface,
} from "../types.js";
import type { CommandOperatorProfile } from "../core/operator-model.js";
import {
  getComputeCommandContract,
  type ComputeCommandArg,
} from "../compute/contracts.js";
import {
  BROWSER_OPERATION_SPECS,
  browserOperationShell,
} from "../commands/browser/operation-spec.js";

export interface CoreDiscoveryArg extends AdapterArg {
  name: string;
  type?: AdapterArg["type"];
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
  execution_operator?: ExecutionOperator;
  execution_profile?: Partial<
    Omit<
      CommandOperatorProfile,
      | "operator"
      | "selection_reason"
      | "operator_source"
      | "operator_confidence"
    >
  >;
  operation_effect?: OperationEffect;
  operation_family?: OperationFamily;
  idempotency?: AdapterCommand["idempotency"];
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
    command: "search",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Search scholarly papers across first-source adapters with fused ranking and optional exact conference and publication-year constraints.",
    capabilities: ["http.fetch", "scholar.search"],
    minimum_capability: "http.fetch",
    args: [
      { name: "query", type: "str", required: true, positional: true },
      { name: "sources", type: "str" },
      { name: "venue", type: "str" },
      { name: "year", type: "str" },
      { name: "limit", type: "int", default: 20 },
      { name: "timeout", type: "str", default: "20" },
      { name: "detailed", type: "bool" },
    ],
  },
  {
    site: "scholar",
    command: "venue",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve a conference name or CCF A alias and search official proceedings sources with exact venue and year validation.",
    capabilities: ["http.fetch", "scholar.venue"],
    minimum_capability: "http.fetch",
    args: [
      { name: "venue", type: "str", required: true, positional: true },
      { name: "sources", type: "str" },
      { name: "query", type: "str" },
      { name: "year", type: "str" },
      { name: "limit", type: "int", default: 50 },
      { name: "timeout", type: "str", default: "20" },
      { name: "detailed", type: "bool" },
    ],
  },
  {
    site: "scholar",
    command: "get",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve one scholarly work from a DOI, arXiv id, PMID, OpenReview id, source-local id, or exact title.",
    capabilities: ["http.fetch", "scholar.get"],
    minimum_capability: "http.fetch",
    args: [
      { name: "ref", type: "str", required: true, positional: true },
      { name: "source", type: "str" },
      { name: "sources", type: "str" },
      { name: "detailed", type: "bool" },
    ],
  },
  {
    site: "scholar",
    command: "pdf",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Resolve only scholarly records that expose a source-backed PDF URL.",
    capabilities: ["http.fetch", "scholar.pdf"],
    minimum_capability: "http.fetch",
    args: [
      { name: "ref", type: "str", required: true, positional: true },
      { name: "source", type: "str" },
      { name: "sources", type: "str" },
      { name: "detailed", type: "bool" },
    ],
  },
  {
    site: "scholar",
    command: "citations",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description: "List works that cite one resolved scholarly paper.",
    capabilities: ["http.fetch", "scholar.citations"],
    minimum_capability: "http.fetch",
    args: [
      { name: "ref", type: "str", required: true, positional: true },
      { name: "source", type: "str" },
      { name: "sources", type: "str" },
      { name: "detailed", type: "bool" },
    ],
  },
  {
    site: "scholar",
    command: "references",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description: "List references cited by one resolved scholarly paper.",
    capabilities: ["http.fetch", "scholar.references"],
    minimum_capability: "http.fetch",
    args: [
      { name: "ref", type: "str", required: true, positional: true },
      { name: "source", type: "str" },
      { name: "sources", type: "str" },
      { name: "detailed", type: "bool" },
    ],
  },
  {
    site: "scholar",
    command: "doctor",
    category: "scholarly",
    type: "service",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Inspect registered scholarly source capabilities and optionally run bounded live probes.",
    capabilities: ["scholar.search"],
    args: [
      { name: "sources", type: "str" },
      { name: "live", type: "bool" },
      { name: "query", type: "str" },
      { name: "limit", type: "int", default: 1 },
      { name: "detailed", type: "bool" },
    ],
  },
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
    command: "trace",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "Trace one paper across publisher metadata, official conference programs and awards, OpenReview review threads and rebuttals, PDFs, code, and datasets by DOI, title, or source identifier.",
    capabilities: [
      "http.fetch",
      "scholar.get",
      "scholar.search",
      "scholar.context",
      "scholar.awards",
      "scholar.review",
      "scholar.pdf",
      "scholar.code",
      "scholar.datasets",
    ],
    minimum_capability: "http.fetch",
    operation_effect: "read",
    operation_family: "get",
    args: [
      {
        name: "ref",
        type: "str",
        required: true,
        positional: true,
        description: "DOI, exact title, arXiv id, PMID, or OpenReview id",
      },
      { name: "source", type: "str", description: "Force one metadata source" },
      { name: "sources", type: "str", description: "Metadata source list" },
      {
        name: "context-sources",
        type: "str",
        description: "Official program and award source list",
      },
      { name: "venue", type: "str", description: "Conference override" },
      { name: "year", type: "str", description: "Conference year override" },
      { name: "limit", type: "int", default: 20 },
      { name: "detailed", type: "bool", description: "Include raw context" },
    ],
  },
  {
    site: "scholar",
    command: "awards",
    category: "scholarly",
    type: "web-api",
    target_surface: "web",
    source_path: "src/commands/scholar.ts",
    description:
      "List source-backed official conference award records, paper identifiers, DOI links, authors, and conference-program evidence.",
    capabilities: ["http.fetch", "scholar.awards", "scholar.context"],
    minimum_capability: "http.fetch",
    operation_effect: "read",
    operation_family: "list",
    args: [
      {
        name: "venue",
        type: "str",
        required: true,
        positional: true,
        description: "Conference acronym or name",
      },
      { name: "source", type: "str", description: "Force one award source" },
      { name: "sources", type: "str", description: "Award source list" },
      { name: "year", type: "str", description: "Conference year" },
      { name: "query", type: "str", description: "Filter award records" },
      {
        name: "award",
        type: "str",
        default: "all",
        choices: ["all", "best-paper", "honorable-mention"],
      },
      { name: "limit", type: "int", default: 100 },
      { name: "detailed", type: "bool", description: "Include raw context" },
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
  ...BROWSER_OPERATION_SPECS.map((spec) => ({
    site: "browser",
    command: spec.command,
    category: "dev",
    type: "browser",
    target_surface: "web" as const,
    source_path: spec.source_path,
    description: spec.description,
    args: spec.args.map(({ flags: _flags, ...arg }) => ({
      ...arg,
      ...(arg.choices ? { choices: [...arg.choices] } : {}),
    })),
    channels: { shell: browserOperationShell(spec) },
    capabilities: [spec.capability],
    minimum_capability: spec.capability,
    execution_operator: spec.execution_operator,
    execution_profile: {
      provider: "cdp-browser",
      perception: spec.perception,
      actuation: spec.actuation,
      target_scope: "browser-renderer" as const,
      verification: spec.verification,
      interaction_impact: spec.interaction_impact,
      coordinate_actuation: false,
    },
    operation_effect: spec.operation_effect,
    operation_family: spec.operation_family,
    idempotency: spec.idempotency,
  })),
  {
    site: "browser",
    command: "bind",
    category: "dev",
    type: "browser",
    target_surface: "web",
    operation_family: "update",
    operation_effect: "service_state",
    idempotency: "conditional",
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
    operation_effect: "unknown_write",
    idempotency: "none",
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
    operation_effect: "unknown_write",
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
      "Emit Uni-CLI's callable Agent-Computer Interface architecture tree, including operation contracts, control kernel, action substrates, evidence delivery, runtime exposure, internal authoring cycle, and verification roots.",
  },
  {
    site: "architecture",
    command: "audit",
    category: "dev",
    type: "service",
    description:
      "Audit Uni-CLI Agent-Computer Interface catalog contracts, including command counts, local computer-use coverage, control stages, missing source paths, and substrate identity boundaries without claiming runtime readiness.",
  },
  {
    site: "compute",
    command: "route",
    category: "desktop",
    type: "service",
    target_surface: "system",
    source_path: "src/commands/compute.ts",
    execution_operator: "local-runtime",
    description:
      "Explain the single native, browser, process, driver, or visual provider selected for one compute operation without opening or executing that provider.",
    args: [
      {
        name: "operation",
        type: "str",
        required: true,
        positional: true,
        description: "Compute command name such as snapshot, click, or launch",
      },
      {
        name: "params",
        type: "str",
        default: "{}",
        description: "Operation arguments encoded as one JSON object",
      },
      {
        name: "via",
        type: "str",
        choices: ["native", "browser", "process", "driver", "visual"],
        description: "Explicit route override",
      },
    ],
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
    command: "point-click",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("point-click"),
  },
  {
    site: "compute",
    command: "drag",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("drag"),
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
    command: "text",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("text"),
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
    command: "point-scroll",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("point-scroll"),
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
    command: "session-start",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("session-start"),
  },
  {
    site: "compute",
    command: "session-state",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("session-state"),
  },
  {
    site: "compute",
    command: "session-escalate",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("session-escalate"),
  },
  {
    site: "compute",
    command: "session-end",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("session-end"),
  },
  {
    site: "compute",
    command: "screen-size",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("screen-size"),
  },
  {
    site: "compute",
    command: "cursor-position",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("cursor-position"),
  },
  {
    site: "compute",
    command: "move-cursor",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("move-cursor"),
  },
  {
    site: "compute",
    command: "agent-cursor-state",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("agent-cursor-state"),
  },
  {
    site: "compute",
    command: "agent-cursor-enable",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("agent-cursor-enable"),
  },
  {
    site: "compute",
    command: "agent-cursor-motion",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("agent-cursor-motion"),
  },
  {
    site: "compute",
    command: "agent-cursor-theme",
    category: "desktop",
    type: "desktop",
    target_surface: "desktop",
    ...computeCommandFields("agent-cursor-theme"),
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

const SORTED_CORE_DISCOVERY_COMMANDS = Object.freeze(
  CORE_DISCOVERY_COMMANDS.map(withCoreSourcePath).sort(
    (a, b) =>
      a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
  ),
);
const CORE_DISCOVERY_COMMAND_BY_ID = new Map<string, CoreDiscoveryCommand>();
const CORE_DISCOVERY_CATEGORY_BY_SITE = new Map<string, string>();
const CORE_DISCOVERY_SITES: ReadonlyArray<{
  site: string;
  category: string;
  type: string;
  commands: readonly CoreDiscoveryCommand[];
}> = (() => {
  const sites = new Map<
    string,
    {
      category: string;
      type: string;
      commands: CoreDiscoveryCommand[];
    }
  >();
  for (const command of SORTED_CORE_DISCOVERY_COMMANDS) {
    const id = `${command.site}\u0000${command.command}`;
    if (CORE_DISCOVERY_COMMAND_BY_ID.has(id)) {
      throw new Error(
        `duplicate core discovery command: ${command.site}/${command.command}`,
      );
    }
    CORE_DISCOVERY_COMMAND_BY_ID.set(id, command);
    const existing = sites.get(command.site);
    if (existing && existing.category !== command.category) {
      throw new Error(
        `inconsistent core discovery site category: ${command.site}`,
      );
    }
    const site = existing ?? {
      category: command.category,
      type: command.type,
      commands: [],
    };
    site.commands.push(command);
    sites.set(command.site, site);
    CORE_DISCOVERY_CATEGORY_BY_SITE.set(command.site, command.category);
  }
  return Object.freeze(
    [...sites.entries()].map(([site, info]) => ({
      site,
      category: info.category,
      type: info.type,
      commands: Object.freeze([...info.commands]),
    })),
  );
})();

export function listCoreDiscoveryCommands(): CoreDiscoveryCommand[] {
  return SORTED_CORE_DISCOVERY_COMMANDS.map((command) => ({ ...command }));
}

export function getCoreDiscoveryCommand(
  site: string,
  command: string,
): CoreDiscoveryCommand | undefined {
  const coreCommand = CORE_DISCOVERY_COMMAND_BY_ID.get(
    `${site}\u0000${command}`,
  );
  return coreCommand ? { ...coreCommand } : undefined;
}

export function listCoreDiscoverySites(): Array<{
  site: string;
  category: string;
  type: string;
  commands: CoreDiscoveryCommand[];
}> {
  return CORE_DISCOVERY_SITES.map((site) => ({
    site: site.site,
    category: site.category,
    type: site.type,
    commands: site.commands.map((command) => ({ ...command })),
  }));
}

export function coreDiscoveryCategory(site: string): string | undefined {
  return CORE_DISCOVERY_CATEGORY_BY_SITE.get(site);
}

function withCoreSourcePath(
  command: CoreDiscoveryCommand,
): CoreDiscoveryCommand {
  const scholarEffect: OperationEffect | undefined =
    command.site !== "scholar"
      ? undefined
      : ["read", "download"].includes(command.command)
        ? "download_file"
        : "read";
  const scholarFamily: OperationFamily | undefined =
    command.site !== "scholar"
      ? undefined
      : command.command === "search" ||
          command.command === "code" ||
          command.command === "datasets"
        ? "search"
        : [
              "venue",
              "citations",
              "references",
              "sources",
              "awards",
              "reviews",
            ].includes(command.command)
          ? "list"
          : command.command === "download"
            ? "download"
            : "get";
  return {
    ...command,
    source_path: command.source_path ?? CORE_COMMAND_SOURCE_PATHS[command.site],
    operation_effect: command.operation_effect ?? scholarEffect,
    operation_family: command.operation_family ?? scholarFamily,
  };
}

function computeCommandFields(
  command: string,
): Pick<
  CoreDiscoveryCommand,
  | "args"
  | "channels"
  | "description"
  | "execution_operator"
  | "execution_profile"
  | "operation_effect"
> {
  const contract = getComputeCommandContract(command);
  if (!contract) {
    throw new Error(`missing compute command contract for ${command}`);
  }
  return {
    description: contract.description,
    execution_operator: contract.executionOperator,
    ...(contract.executionProfile
      ? { execution_profile: contract.executionProfile }
      : {}),
    operation_effect: contract.readOnly === true ? "read" : "local_app",
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
    ...(arg.minimum === undefined ? {} : { minimum: arg.minimum }),
    ...(arg.maximum === undefined ? {} : { maximum: arg.maximum }),
    ...(arg.minLength === undefined ? {} : { minLength: arg.minLength }),
    ...(arg.maxLength === undefined ? {} : { maxLength: arg.maxLength }),
  };
}
