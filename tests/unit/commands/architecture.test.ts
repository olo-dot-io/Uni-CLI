import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerArchitectureCommand } from "../../../src/commands/architecture.js";
import { getCoreDiscoveryCommand } from "../../../src/discovery/core-catalog.js";
import { validateEnvelope } from "../../../src/output/envelope.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";

const fixtureAdapters: AdapterManifest[] = [
  {
    name: "demo",
    type: AdapterType.WEB_API,
    commands: {
      search: {
        name: "search",
        adapter_path: "src/adapters/demo/search.yaml",
        capabilities: ["http.fetch"],
        minimum_capability: "http.fetch",
      },
    },
  },
];

function captureStdout(): { read: () => string; restore: () => void } {
  let stdoutText = "";
  const originalLog = console.log;
  console.log = ((...parts: unknown[]) => {
    stdoutText += parts.map(String).join(" ") + "\n";
  }) as typeof console.log;
  return {
    read: () => stdoutText,
    restore: () => {
      console.log = originalLog;
    },
  };
}

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <format>", "output format");
  registerArchitectureCommand(program, {
    getAdapters: () => fixtureAdapters,
    getCoreCommands: () => [],
  });
  return program;
}

describe("unicli architecture", () => {
  it("registers architecture audit as a discoverable core command", () => {
    const coreCommand = getCoreDiscoveryCommand("architecture", "audit");

    expect(coreCommand?.description).toContain("computer-control");
    expect(coreCommand?.type).toBe("service");
    expect(coreCommand?.source_path).toBe("src/commands/architecture.ts");
  });

  it("emits an envelope with the callable architecture tree", async () => {
    const capture = captureStdout();
    try {
      await newProgram().parseAsync(["-f", "json", "architecture", "tree"], {
        from: "user",
      });
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.read()) as Record<string, unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("architecture.tree");
    expect((envelope.data as { root: { id: string } }).root.id).toBe("unicli");
    validateEnvelope(envelope as Parameters<typeof validateEnvelope>[0]);
  });

  it("emits an audit envelope that agents can use before restructuring", async () => {
    const capture = captureStdout();
    try {
      await newProgram().parseAsync(["-f", "json", "architecture", "audit"], {
        from: "user",
      });
    } finally {
      capture.restore();
    }

    const envelope = JSON.parse(capture.read()) as Record<string, unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("architecture.audit");
    expect((envelope.data as { total_commands: number }).total_commands).toBe(
      1,
    );
    expect(
      (
        envelope.data as {
          capability_matrix: Array<{ surface: string }>;
          workflow_readiness: Array<{ id: string }>;
        }
      ).capability_matrix.map((entry) => entry.surface),
    ).toContain("web");
    expect(
      (
        envelope.data as {
          capability_matrix: Array<{ surface: string }>;
          workflow_readiness: Array<{ id: string }>;
        }
      ).workflow_readiness.map((entry) => entry.id),
    ).toContain("video-search");
    validateEnvelope(envelope as Parameters<typeof validateEnvelope>[0]);
  });
});
