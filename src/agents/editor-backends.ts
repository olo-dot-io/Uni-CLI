import type { AgentBackendProfileInput } from "./backends.js";

const EDITOR_MCP_POLICY =
  "Treat the editor extension as the session owner. Uni-CLI should enter through MCP and avoid pretending the extension is a headless runtime.";

export const EDITOR_BACKENDS: readonly AgentBackendProfileInput[] = [
  {
    id: "cline",
    display_name: "Cline",
    aliases: ["cline agent", "cline extension"],
    binaries: [],
    primary_route: "mcp",
    protocols: ["mcp"],
    tier: "bridge",
    maturity: "stable",
    install_hint:
      "Install Cline in the editor and add Uni-CLI as an MCP server.",
    probe: "editor-extension",
    strengths: ["large VS Code install base", "MCP tool use", "BYOK"],
    risks: [
      "no stable headless CLI contract",
      "session state lives in VS Code",
    ],
    policy: EDITOR_MCP_POLICY,
  },
  {
    id: "roo-code",
    display_name: "Roo Code",
    aliases: ["roo", "roo code", "roo-code"],
    binaries: [],
    primary_route: "mcp",
    protocols: ["mcp"],
    tier: "bridge",
    maturity: "stable",
    install_hint: "Install Roo Code in the editor and configure Uni-CLI MCP.",
    probe: "editor-extension",
    strengths: ["Cline-family workflows", "MCP integration", "mode routing"],
    risks: ["extension-owned state", "no verified standalone runtime"],
    policy: EDITOR_MCP_POLICY,
  },
  {
    id: "windsurf",
    display_name: "Windsurf Cascade",
    aliases: ["windsurf", "cascade", "windsurf cascade"],
    binaries: [],
    primary_route: "mcp",
    protocols: ["mcp"],
    tier: "bridge",
    maturity: "fast-moving",
    install_hint: "Configure Uni-CLI as MCP inside Windsurf/Cascade.",
    probe: "editor-extension",
    strengths: ["IDE-native coding loop", "codebase context", "MCP tools"],
    risks: [
      "proprietary editor state",
      "headless automation is not guaranteed",
    ],
    policy: EDITOR_MCP_POLICY,
  },
  {
    id: "continue",
    display_name: "Continue",
    aliases: ["continue dev", "continue cli", "continue extension"],
    binaries: [],
    primary_route: "mcp",
    protocols: ["mcp"],
    tier: "bridge",
    maturity: "stable",
    install_hint: "Configure Uni-CLI through Continue's MCP/tool settings.",
    probe: "editor-extension",
    strengths: ["open-source IDE agent", "provider flexibility", "MCP tools"],
    risks: ["CLI package exposes a short `cn` bin", "IDE owns sessions"],
    policy: EDITOR_MCP_POLICY,
  },
];
