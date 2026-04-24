import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerSearchCommand } from "../../../src/commands/search.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

function captureStdout(): {
  getStdout: () => string;
  restore: () => void;
} {
  let out = "";
  const origLog = console.log;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  return {
    getStdout: () => out,
    restore: () => {
      console.log = origLog;
    },
  };
}

describe("unicli search", () => {
  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerSearchCommand(program);
    return program;
  }

  it("honors the root -f json option", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(["-f", "json", "search", "推特热门"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("core.search");
    expect(Array.isArray(env.data)).toBe(true);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });
});
