/**
 * Agent backend matrix — anti-consensus bridge policy.
 *
 * The core decision is deliberate: ACP is an editor compatibility protocol,
 * not Uni-CLI's agent runtime. Prefer direct process/json/MCP routes for
 * first-token latency, session ownership, and provider-specific features.
 */

import { EDITOR_BACKENDS } from "./editor-backends.js";

export type AgentProtocol =
  | "native_cli"
  | "json_stream"
  | "mcp"
  | "acp"
  | "http_api"
  | "openai_compatible"
  | "gh_extension"
  | "terminal"
  | "api";

export type AgentRoute =
  | "native_cli"
  | "json_stream"
  | "mcp"
  | "acpx"
  | "http_api"
  | "gh_extension"
  | "openai_compatible"
  | "api_cli";

export type AgentMaturity = "stable" | "fast-moving" | "experimental";
export type AgentBackendTier = "core" | "sota" | "bridge" | "watchlist";

export interface AgentBackendProfile {
  id: string;
  display_name: string;
  aliases: string[];
  binaries: string[];
  primary_route: AgentRoute;
  primary_protocol: AgentProtocol;
  protocols: AgentProtocol[];
  external_cli_name?: string;
  tier: AgentBackendTier;
  maturity: AgentMaturity;
  install_hint: string;
  probe: string;
  strengths: string[];
  risks: string[];
  policy: string;
}

export interface AgentBackendRecommendation {
  backend: AgentBackendProfile;
  route: AgentRoute;
  fallbacks: AgentProtocol[];
  rationale: string;
  risks: string[];
}

export type AgentBackendProfileInput = Omit<
  AgentBackendProfile,
  "primary_protocol"
> & {
  primary_protocol?: AgentProtocol;
};

const ACP_COMPAT =
  "ACP is compatibility: expose it for editors and registries, but keep Uni-CLI's core loop on direct process/json/MCP routes.";

const AGENT_BACKENDS: readonly AgentBackendProfileInput[] = [
  {
    id: "claude-code",
    display_name: "Claude Code",
    aliases: ["claude", "claudecode", "claude agent"],
    binaries: ["claude"],
    primary_route: "json_stream",
    protocols: ["native_cli", "json_stream", "mcp", "acp", "terminal"],
    external_cli_name: "claude-code",
    tier: "core",
    maturity: "stable",
    install_hint: "Install Claude Code, then expose Uni-CLI through MCP.",
    probe: "claude --version",
    strengths: [
      "strong coding loop",
      "project memory",
      "MCP tool access",
      "structured stream output",
    ],
    risks: [
      "subscription/auth constraints",
      "provider-specific slash commands do not map cleanly to ACP",
    ],
    policy: ACP_COMPAT,
  },
  {
    id: "codex",
    display_name: "Codex CLI",
    aliases: ["codex-cli", "openai codex", "codex agent"],
    binaries: ["codex"],
    primary_route: "json_stream",
    protocols: ["native_cli", "json_stream", "mcp", "acp", "terminal"],
    external_cli_name: "codex-cli",
    tier: "core",
    maturity: "fast-moving",
    install_hint: "Install Codex CLI and configure Uni-CLI as an MCP server.",
    probe: "codex --version",
    strengths: [
      "AGENTS.md-native workflow",
      "good codebase execution loop",
      "MCP tool access",
    ],
    risks: [
      "ACP support changes quickly",
      "session semantics should stay in Codex, not in an ACP shim",
    ],
    policy: ACP_COMPAT,
  },
  {
    id: "acpx",
    display_name: "OpenClaw acpx",
    aliases: ["openclaw", "acpx", "claw"],
    binaries: ["acpx"],
    primary_route: "acpx",
    protocols: ["native_cli", "mcp", "acp", "terminal"],
    external_cli_name: "acpx",
    tier: "bridge",
    maturity: "fast-moving",
    install_hint: "Install acpx and use ACP only at the bridge edge.",
    probe: "acpx --version",
    strengths: [
      "multi-agent orchestration",
      "agent-to-agent routing",
      "ACP bridge ecosystem",
    ],
    risks: [
      "bridge layers can hide first-token latency",
      "agent-specific features need explicit passthrough",
    ],
    policy: ACP_COMPAT,
  },
  {
    id: "hermes",
    display_name: "Hermes Agent",
    aliases: ["hermes-agent", "hermes agent", "nous hermes"],
    binaries: ["hermes"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "terminal"],
    external_cli_name: "hermes-agent",
    tier: "core",
    maturity: "experimental",
    install_hint:
      "Use Hermes local skills and session files with Uni-CLI adapters.",
    probe: "hermes --version",
    strengths: [
      "local skills",
      "local session index",
      "filesystem-readable memory",
    ],
    risks: [
      "less standardized than MCP/ACP clients",
      "capability discovery depends on local Hermes layout",
    ],
    policy:
      "Prefer direct Hermes files/CLI surfaces; add protocol bridges only after the native loop is measurable.",
  },
  {
    id: "cursor",
    display_name: "Cursor Agent",
    aliases: ["cursor", "cursor-agent", "cursor cli"],
    binaries: ["cursor-agent", "cursor"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "acp", "terminal"],
    external_cli_name: "cursor-agent",
    tier: "core",
    maturity: "fast-moving",
    install_hint:
      "Use Cursor's own agent binary when available; MCP remains the Uni-CLI tool path.",
    probe: "cursor-agent --version || cursor --version",
    strengths: [
      "Composer/codebase index",
      "large installed base",
      "JetBrains/Zed ACP distribution",
    ],
    risks: [
      "ACP plan/session events have shown provider-specific gaps",
      "MCP servers may need separate Cursor-side enablement",
    ],
    policy: ACP_COMPAT,
  },
  {
    id: "kimi-cli",
    display_name: "Kimi CLI",
    aliases: ["kimi", "kimi cli", "moonshot", "moonshot kimi"],
    binaries: ["kimi"],
    primary_route: "native_cli",
    protocols: ["native_cli", "json_stream", "mcp", "acp", "terminal"],
    external_cli_name: "kimi-cli",
    tier: "core",
    maturity: "fast-moving",
    install_hint:
      "Install kimi-cli and route Uni-CLI through direct CLI/MCP first.",
    probe: "kimi --version",
    strengths: [
      "coding-agent CLI",
      "Moonshot model access",
      "can sit behind direct command dispatch",
    ],
    risks: [
      "provider flags may drift",
      "ACP support should be treated as optional integration",
    ],
    policy: ACP_COMPAT,
  },
  {
    id: "minimax-cli",
    display_name: "MiniMax CLI",
    aliases: ["minimax", "minimax cli", "mmx", "minimax agent"],
    binaries: ["mmx"],
    primary_route: "api_cli",
    protocols: ["native_cli", "api", "terminal"],
    external_cli_name: "mmx-cli",
    tier: "watchlist",
    maturity: "experimental",
    install_hint:
      "Install mmx-cli for MiniMax model/media calls; wrap coding loops explicitly.",
    probe: "mmx --version",
    strengths: [
      "model/media API surface",
      "useful as a specialist backend",
      "already fits Uni-CLI's adapter model",
    ],
    risks: [
      "not a complete coding-agent loop by default",
      "needs explicit tool/session orchestration",
    ],
    policy:
      "Treat MiniMax as a specialist backend, not a universal ACP agent. Use direct API/CLI calls and compose with Uni-CLI.",
  },
  {
    id: "opencode",
    display_name: "OpenCode",
    aliases: ["opencode-cli", "opencode ai", "opencode-ai"],
    binaries: ["opencode"],
    primary_route: "json_stream",
    protocols: ["native_cli", "json_stream", "mcp", "acp", "terminal"],
    external_cli_name: "opencode-cli",
    tier: "sota",
    maturity: "fast-moving",
    install_hint: "Install opencode-ai; prefer native CLI/JSON before ACP.",
    probe: "opencode --version",
    strengths: [
      "open-source terminal agent",
      "many provider backends",
      "session persistence",
    ],
    risks: [
      "project lineage and package names moved quickly",
      "TUI details should not be scraped unless no structured mode exists",
    ],
    policy: ACP_COMPAT,
  },
  {
    id: "gemini-cli",
    display_name: "Gemini CLI",
    aliases: ["gemini", "google gemini cli", "gemini agent"],
    binaries: ["gemini"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "terminal"],
    external_cli_name: "gemini-cli",
    tier: "sota",
    maturity: "stable",
    install_hint: "Install @google/gemini-cli and use MCP for Uni-CLI tools.",
    probe: "gemini --version",
    strengths: ["large context window", "free tier", "Google OAuth/API key"],
    risks: [
      "model behavior differs sharply between free and paid/provider modes",
      "headless output support must be probed per release",
    ],
    policy:
      "Route through Gemini's native CLI first; use MCP for tools and avoid assuming ACP parity.",
  },
  {
    id: "qwen-code",
    display_name: "Qwen Code",
    aliases: ["qwen", "qwen cli", "qwen-code", "qwen agent"],
    binaries: ["qwen"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "terminal", "openai_compatible"],
    external_cli_name: "qwen-code",
    tier: "sota",
    maturity: "fast-moving",
    install_hint: "Install @qwen-code/qwen-code; use direct CLI first.",
    probe: "qwen --version",
    strengths: [
      "open-source terminal agent",
      "Qwen/OpenAI-compatible providers",
      "fast adoption in CJK workflows",
    ],
    risks: [
      "flags and provider setup are still moving",
      "ACP should be treated as bridge-only until proven by probe",
    ],
    policy:
      "Prefer native qwen execution and OpenAI-compatible provider config; expose Uni-CLI over MCP when tools are needed.",
  },
  {
    id: "kiro-cli",
    display_name: "Kiro CLI",
    aliases: ["kiro", "amazon q", "amazon q cli", "amazon q developer"],
    binaries: ["kiro-cli"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "terminal"],
    external_cli_name: "kiro-cli",
    tier: "sota",
    maturity: "fast-moving",
    install_hint: "Install from https://cli.kiro.dev/install.",
    probe: "kiro-cli --version",
    strengths: ["Amazon Q CLI successor", "terminal workflow", "MCP"],
    risks: [
      "public npm packages named kiro/kiro-cli are unrelated or placeholders",
      "distribution should stay on the official Kiro channel",
    ],
    policy:
      "Route Kiro through its native CLI. Treat Amazon Q Developer CLI names as legacy aliases, not a separate backend.",
  },
  {
    id: "aider",
    display_name: "Aider",
    aliases: ["aider-chat", "aider ai", "aider agent"],
    binaries: ["aider"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal", "openai_compatible"],
    external_cli_name: "aider",
    tier: "sota",
    maturity: "stable",
    install_hint: "Install aider-chat with pipx or pip.",
    probe: "aider --version",
    strengths: ["mature CLI pair-programming loop", "git-aware edits", "BYOK"],
    risks: [
      "not every workflow is an autonomous coding-agent session",
      "streaming and provider quirks need per-model probes",
    ],
    policy:
      "Use Aider as a direct file-editing backend; wrap it with HTTP only when session/event control is required.",
  },
  {
    id: "goose",
    display_name: "Goose",
    aliases: ["goose-cli", "block goose", "aaif goose"],
    binaries: ["goose"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "terminal"],
    external_cli_name: "goose",
    tier: "sota",
    maturity: "stable",
    install_hint: "Install Goose from its official release channel.",
    probe: "goose --version",
    strengths: ["open-source extensible agent", "MCP-native posture", "BYOK"],
    risks: [
      "extension/provider setup can be local-state heavy",
      "TUI automation is less reliable than native command/session APIs",
    ],
    policy:
      "Prefer Goose's own CLI/session model and MCP extension path; do not force it through ACP.",
  },
  {
    id: "amp",
    display_name: "Amp",
    aliases: ["sourcegraph amp", "ampcode", "amp agent"],
    binaries: ["amp"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal"],
    external_cli_name: "amp",
    tier: "sota",
    maturity: "fast-moving",
    install_hint: "Install @sourcegraph/amp when available for your account.",
    probe: "amp --version",
    strengths: ["frontier coding-agent UX", "strong planning/edit loop"],
    risks: [
      "account and subscription gating",
      "structured output contracts need release-by-release probing",
    ],
    policy:
      "Treat Amp as a native subscribed agent. Keep Uni-CLI as an external tool bus rather than a protocol shim.",
  },
  {
    id: "github-copilot-cli",
    display_name: "GitHub Copilot CLI",
    aliases: ["copilot", "gh copilot", "github copilot"],
    binaries: ["gh", "copilot"],
    primary_route: "gh_extension",
    protocols: ["gh_extension", "native_cli", "terminal"],
    external_cli_name: "github-copilot-cli",
    tier: "sota",
    maturity: "stable",
    install_hint: "Install @github/copilot or the GitHub CLI Copilot surface.",
    probe: "gh copilot --help || copilot --version",
    strengths: ["GitHub auth", "ubiquitous developer install base"],
    risks: [
      "not always a full autonomous coding loop",
      "GitHub CLI extension output is command-specific",
    ],
    policy:
      "Use GitHub's own CLI/extension path for shell and repo tasks; escalate to MCP only for Uni-CLI catalog access.",
  },
  {
    id: "auggie",
    display_name: "Auggie CLI",
    aliases: ["augment", "augment code", "auggie cli"],
    binaries: ["auggie"],
    primary_route: "native_cli",
    protocols: ["native_cli", "mcp", "terminal"],
    external_cli_name: "auggie",
    tier: "sota",
    maturity: "fast-moving",
    install_hint: "Install @augmentcode/auggie.",
    probe: "auggie --version",
    strengths: ["Augment codebase index", "IDE and terminal surfaces"],
    risks: [
      "proprietary account gating",
      "local index semantics should remain owned by Augment",
    ],
    policy:
      "Treat Auggie as a native indexed agent; Uni-CLI should provide external capabilities, not duplicate its index.",
  },
  {
    id: "crush",
    display_name: "Charm Crush",
    aliases: ["charm crush", "crush cli"],
    binaries: ["crush"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal", "openai_compatible"],
    external_cli_name: "crush",
    tier: "sota",
    maturity: "fast-moving",
    install_hint: "Install Charm Crush from its official release channel.",
    probe: "crush --version",
    strengths: ["open-source TUI", "headless run mode", "provider flexibility"],
    risks: [
      "rapid release cadence",
      "TUI snapshots are weaker than explicit headless commands",
    ],
    policy:
      "Prefer headless/native Crush commands for automation; reserve TUI driving for human-in-the-loop sessions.",
  },
  {
    id: "openhands",
    display_name: "OpenHands",
    aliases: ["open hands", "openhands-ai", "openhands cli"],
    binaries: ["openhands"],
    primary_route: "native_cli",
    protocols: ["native_cli", "http_api", "terminal", "openai_compatible"],
    external_cli_name: "openhands",
    tier: "sota",
    maturity: "stable",
    install_hint: "Install openhands-ai or use the official container.",
    probe: "openhands --version",
    strengths: [
      "large open-source project",
      "sandbox/container workflows",
      "browser and code tooling",
    ],
    risks: [
      "heavier runtime than a pure CLI",
      "container/session lifecycle must be explicit",
    ],
    policy:
      "Use OpenHands for sandboxed autonomous tasks; route Uni-CLI through its native tool or HTTP surface.",
  },
  {
    id: "mini-swe-agent",
    display_name: "mini-SWE-agent",
    aliases: ["mini", "mini swe", "mini-swe", "mini swe agent"],
    binaries: ["mini"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal"],
    external_cli_name: "mini-swe-agent",
    tier: "sota",
    maturity: "stable",
    install_hint: "Install mini-swe-agent with pipx or pip.",
    probe: "mini --help",
    strengths: ["small repair runner", "current SWE-agent path", "SWE-bench"],
    risks: [
      "short binary name requires registry-backed routing",
      "better for issue repair than general chat",
    ],
    policy:
      "Prefer mini-SWE-agent for new SWE-agent-style repair/eval loops; keep classic SWE-agent as a legacy harness.",
  },
  {
    id: "swe-agent",
    display_name: "SWE-agent",
    aliases: ["sweagent", "swe agent", "swe-agent cli"],
    binaries: ["sweagent", "swe-agent"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal"],
    external_cli_name: "swe-agent",
    tier: "watchlist",
    maturity: "stable",
    install_hint:
      "Install SWE-agent from the official repo only when the classic harness is required.",
    probe: "sweagent --help || swe-agent --help",
    strengths: ["benchmark-oriented repair loop", "reproducible task harness"],
    risks: [
      "better as a benchmark/repair runner than an everyday chat agent",
      "environment setup dominates latency",
    ],
    policy:
      "Keep classic SWE-agent for legacy benchmark harnesses; prefer mini-SWE-agent for new direct CLI automation.",
  },
  {
    id: "agentapi",
    display_name: "AgentAPI",
    aliases: ["coder agentapi", "agent api", "agentapi server"],
    binaries: ["agentapi"],
    primary_route: "http_api",
    protocols: ["http_api", "native_cli", "terminal"],
    external_cli_name: "agentapi",
    tier: "bridge",
    maturity: "fast-moving",
    install_hint:
      "Install coder/agentapi and run `agentapi server --type=<agent> -- <agent>`.",
    probe: "agentapi --version",
    strengths: [
      "HTTP/SSE control plane",
      "supports many native coding-agent CLIs",
      "status and message APIs",
    ],
    risks: [
      "adapters can break when upstream TUIs change",
      "must specify agent type to preserve message formatting",
    ],
    policy:
      "Use AgentAPI as a bridge when Uni-CLI needs session/event control across native agents; do not treat it as the model runtime.",
  },
  {
    id: "blackbox-cli",
    display_name: "Blackbox CLI",
    aliases: ["blackbox", "blackbox ai", "blackbox agent"],
    binaries: ["blackbox"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal"],
    tier: "watchlist",
    maturity: "experimental",
    install_hint:
      "Install Blackbox CLI from an official channel only after confirming it exposes a stable non-generic binary.",
    probe: "blackbox --version",
    strengths: [
      "agent picker/orchestration UX",
      "routes across Claude/Codex/Gemini-style tools",
    ],
    risks: [
      "marketing claims should not be accepted without probes",
      "the public npm package exposes a generic `cli` bin, which is unsafe for auto-routing",
    ],
    policy:
      "Treat Blackbox as an optional orchestration frontend. Prefer direct backends when exact agent semantics matter.",
  },
  {
    id: "droid",
    display_name: "Droid CLI",
    aliases: ["factory droid", "factory ai droid", "droid cli"],
    binaries: ["droid"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal", "openai_compatible"],
    external_cli_name: "droid-cli",
    tier: "watchlist",
    maturity: "fast-moving",
    install_hint: "Install Droid from Factory's official channel.",
    probe: "droid --version",
    strengths: ["agent-native terminal workflow", "frontier model access"],
    risks: [
      "install distribution is not always discoverable from public registries",
      "protocol details should be probed before automation",
    ],
    policy:
      "Keep Droid in the matrix as a watchlist backend until install/protocol probes are stable in CI.",
  },
  {
    id: "forgecode",
    display_name: "ForgeCode",
    aliases: ["forge", "forge code", "forgecode cli"],
    binaries: ["forge"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal", "openai_compatible"],
    external_cli_name: "forgecode",
    tier: "watchlist",
    maturity: "fast-moving",
    install_hint: "Install ForgeCode from its official distribution channel.",
    probe: "forge --version",
    strengths: ["pair-programming agent", "provider flexibility"],
    risks: [
      "public package naming is not stable",
      "subscription/provider passthrough needs explicit testing",
    ],
    policy:
      "Treat ForgeCode as a direct CLI candidate, but require a successful binary probe before recommendation in automation.",
  },
  {
    id: "rovo-dev",
    display_name: "Rovo Dev CLI",
    aliases: ["rovo", "atlassian rovo", "rovo dev"],
    binaries: ["rovo"],
    primary_route: "native_cli",
    protocols: ["native_cli", "terminal"],
    external_cli_name: "rovo-dev",
    tier: "watchlist",
    maturity: "fast-moving",
    install_hint: "Install Rovo Dev from Atlassian's official channel.",
    probe: "rovo --version",
    strengths: ["team/workflow integration", "Atlassian ecosystem"],
    risks: [
      "enterprise auth and workspace gating",
      "not all installations expose a generic coding-agent CLI",
    ],
    policy:
      "Expose Rovo as a team-tooling backend only after local auth and binary probes pass.",
  },
];

export function buildAgentBackendMatrix(): AgentBackendProfile[] {
  return [...AGENT_BACKENDS, ...EDITOR_BACKENDS].map((entry) => ({
    ...entry,
    primary_protocol:
      entry.primary_protocol ?? protocolForRoute(entry.primary_route),
    aliases: [...entry.aliases],
    binaries: [...entry.binaries],
    protocols: [...entry.protocols],
    strengths: [...entry.strengths],
    risks: [...entry.risks],
  }));
}

export function findAgentBackend(
  name: string,
): AgentBackendProfile | undefined {
  const needle = normalizeAgentName(name);
  return buildAgentBackendMatrix().find((entry) => {
    if (normalizeAgentName(entry.id) === needle) return true;
    if (normalizeAgentName(entry.display_name) === needle) return true;
    return entry.aliases.some((alias) => normalizeAgentName(alias) === needle);
  });
}

export function recommendAgentBackend(
  name: string,
): AgentBackendRecommendation {
  const backend = findAgentBackend(name);
  if (!backend) {
    throw new Error(`Unknown agent backend: ${name}`);
  }

  const fallbacks = backend.protocols.filter(
    (protocol) => protocol !== backend.primary_protocol,
  );
  return {
    backend,
    route: backend.primary_route,
    fallbacks,
    rationale: [
      `Use ${backend.primary_route}/${backend.primary_protocol} first for lower first-token latency and native session semantics.`,
      "Add MCP for Uni-CLI tool access.",
      backend.protocols.includes("acp")
        ? "Keep ACP at the editor/registry boundary."
        : "No ACP dependency is required for this backend.",
    ].join(" "),
    risks: [...backend.risks],
  };
}

function normalizeAgentName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function protocolForRoute(route: AgentRoute): AgentProtocol {
  switch (route) {
    case "native_cli":
      return "native_cli";
    case "json_stream":
      return "json_stream";
    case "mcp":
      return "mcp";
    case "acpx":
      return "acp";
    case "http_api":
      return "http_api";
    case "gh_extension":
      return "gh_extension";
    case "openai_compatible":
      return "openai_compatible";
    case "api_cli":
      return "api";
  }
}
