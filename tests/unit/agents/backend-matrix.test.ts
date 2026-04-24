import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  buildAgentBackendMatrix,
  findAgentBackend,
  recommendAgentBackend,
} from "../../../src/agents/backends.js";

describe("agent backend matrix", () => {
  it("covers the named coding agents for the bridge scope", () => {
    const matrix = buildAgentBackendMatrix();
    const ids = matrix.map((entry) => entry.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "claude-code",
        "codex",
        "acpx",
        "hermes",
        "cursor",
        "kimi-cli",
        "minimax-cli",
        "opencode",
        "gemini-cli",
        "qwen-code",
        "kiro-cli",
        "aider",
        "goose",
        "amp",
        "github-copilot-cli",
        "auggie",
        "crush",
        "openhands",
        "mini-swe-agent",
        "swe-agent",
        "agentapi",
        "cline",
        "roo-code",
        "windsurf",
        "continue",
      ]),
    );
    expect(matrix.length).toBeGreaterThanOrEqual(29);
  });

  it("treats ACP as compatibility rather than the core runtime", () => {
    const matrix = buildAgentBackendMatrix();
    const acpCapable = matrix.filter((entry) =>
      entry.protocols.includes("acp"),
    );

    expect(acpCapable.length).toBeGreaterThan(0);
    for (const entry of acpCapable) {
      expect(entry.primary_route).not.toBe("acp");
      expect(entry.policy).toContain("ACP is compatibility");
    }
  });

  it("normalizes common aliases when finding backends", () => {
    expect(findAgentBackend("claudecode")?.id).toBe("claude-code");
    expect(findAgentBackend("openclaw")?.id).toBe("acpx");
    expect(findAgentBackend("hermes agent")?.id).toBe("hermes");
    expect(findAgentBackend("minimax")?.id).toBe("minimax-cli");
    expect(findAgentBackend("gemini")?.id).toBe("gemini-cli");
    expect(findAgentBackend("qwen")?.id).toBe("qwen-code");
    expect(findAgentBackend("amazon-q")?.id).toBe("kiro-cli");
    expect(findAgentBackend("amazon q cli")?.id).toBe("kiro-cli");
    expect(findAgentBackend("mini")?.id).toBe("mini-swe-agent");
    expect(findAgentBackend("roo")?.id).toBe("roo-code");
    expect(findAgentBackend("cascade")?.id).toBe("windsurf");
    expect(findAgentBackend("gh copilot")?.id).toBe("github-copilot-cli");
  });

  it("recommends a concrete direct route before protocol gateways", () => {
    const rec = recommendAgentBackend("cursor");

    expect(rec.backend.id).toBe("cursor");
    expect(rec.route).toBe("native_cli");
    expect(rec.fallbacks).toContain("acp");
    expect(rec.rationale).toContain("first-token");
  });

  it("keeps bridges and watchlist tools out of ACP core routing", () => {
    const agentapi = recommendAgentBackend("agentapi");
    const acpx = recommendAgentBackend("openclaw");
    const droid = recommendAgentBackend("droid");
    const blackbox = recommendAgentBackend("blackbox");

    expect(agentapi.backend.tier).toBe("bridge");
    expect(agentapi.route).toBe("http_api");
    expect(acpx.backend.tier).toBe("bridge");
    expect(acpx.route).toBe("acpx");
    expect(acpx.backend.primary_protocol).toBe("acp");
    expect(acpx.fallbacks).not.toContain("acp");
    expect(droid.backend.tier).toBe("watchlist");
    expect(droid.route).toBe("native_cli");
    expect(blackbox.backend.tier).toBe("watchlist");
    expect(blackbox.backend.external_cli_name).toBeUndefined();
  });

  it("keeps editor extensions on MCP rather than fake CLI runtimes", () => {
    for (const agent of ["cline", "roo", "windsurf", "continue"]) {
      const rec = recommendAgentBackend(agent);
      expect(rec.route).toBe("mcp");
      expect(rec.backend.primary_protocol).toBe("mcp");
      expect(rec.backend.binaries).toEqual([]);
    }
  });

  it("bridges backend ids to external CLI registry names", () => {
    expect(recommendAgentBackend("codex").backend.external_cli_name).toBe(
      "codex-cli",
    );
    expect(recommendAgentBackend("cursor").backend.external_cli_name).toBe(
      "cursor-agent",
    );
    expect(recommendAgentBackend("minimax").backend.external_cli_name).toBe(
      "mmx-cli",
    );
  });

  it("does not inflate the external CLI registry with duplicate binaries", () => {
    const raw = readFileSync(
      new URL("../../../src/hub/external-clis.yaml", import.meta.url),
      "utf8",
    );
    const entries = yaml.load(raw) as Array<{ binary: string; name: string }>;
    const duplicateBinaries = entries
      .map((entry) => entry.binary)
      .filter((binary, index, binaries) => binaries.indexOf(binary) !== index);

    expect(entries).toHaveLength(58);
    expect(duplicateBinaries).toEqual([]);
  });
});
