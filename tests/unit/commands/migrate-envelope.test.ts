/**
 * `unicli import legacy-yaml` v2 envelope wrapper tests.
 *
 * Existing `migrate.test.ts` covers the pure `migrateLegacyYaml` function. This
 * file focuses on the command-level envelope emission introduced by T6.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMigrateCommand } from "../../../src/commands/migrate.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

function captureStdout(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

describe("unicli import legacy-yaml — v2 envelope", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-import-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function newProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerMigrateCommand(program);
    return program;
  }

  it("emits an ok envelope carrying the migrated YAML text", async () => {
    const srcPath = join(dir, "src.yaml");
    writeFileSync(
      srcPath,
      `site: example
name: search
auth: none
steps:
  - http: { url: "https://example.com/search" }
`,
    );

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(
        ["-f", "json", "import", "legacy-yaml", srcPath],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("migrate.legacy");
    const data = env.data as {
      input_path: string;
      output_path: string | null;
      yaml: string;
      renamed_steps: string[];
    };
    expect(data.input_path).toBe(srcPath);
    expect(data.output_path).toBeNull();
    expect(data.yaml).toContain("site: example");
    expect(data.renamed_steps).toContain("http -> fetch");
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("emits an error envelope when input YAML is missing", async () => {
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`__EXIT__${code}`);
    }) as typeof process.exit;

    const cap = captureStdout();
    let exitCode: number | null = null;
    try {
      const program = newProgram();
      try {
        await program.parseAsync(
          ["-f", "json", "import", "legacy-yaml", join(dir, "__missing.yaml")],
          { from: "user" },
        );
      } catch (err) {
        const m = /^__EXIT__(\d+)/.exec((err as Error).message);
        if (m) exitCode = parseInt(m[1], 10);
        else throw err;
      }
    } finally {
      cap.restore();
      process.exit = origExit;
    }

    expect(exitCode).toBe(2); // USAGE_ERROR
    const parsed = JSON.parse(cap.getStderr().trim()) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("migrate.legacy");
    const e = parsed.error as { code: string } | undefined;
    expect(e?.code).toBe("invalid_input");
  });
});
