/**
 * `unicli migrate schema-v2` v2 envelope wrapper tests.
 *
 * Existing `migrate-schema.test.ts` covers the pure migration logic
 * (`migrateYamlText` / `inferCapabilities` / ...). This file focuses on the
 * command-level envelope emission introduced by T6.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMigrateSchemaCommand } from "../../../src/commands/migrate-schema.js";
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

describe("unicli migrate schema-v2 — v2 envelope", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-migrate-schema-test-"));
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
    registerMigrateSchemaCommand(program);
    return program;
  }

  it("emits an ok envelope on a --dry-run sweep of an empty directory", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(
        ["-f", "json", "migrate", "schema-v2", "--dry-run", dir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("migrate.schema");
    const data = env.data as {
      mode: string;
      counts: {
        migrated: number;
        already_v2: number;
        quarantined: number;
        skipped: number;
      };
    };
    expect(data.mode).toBe("dry-run");
    expect(data.counts.migrated).toBe(0);
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("emits an error envelope when target does not exist", async () => {
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
          ["-f", "json", "migrate", "schema-v2", join(dir, "__missing_dir__")],
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

    expect(exitCode).toBe(78); // CONFIG_ERROR
    const parsed = JSON.parse(cap.getStderr().trim()) as Record<
      string,
      unknown
    >;
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("migrate.schema");
    const e = parsed.error as { code: string } | undefined;
    expect(e?.code).toBe("invalid_input");
  });

  it("counts migrated files in data.counts when adapters need v2 fields", async () => {
    // v1-style adapter missing all schema-v2 fields
    writeFileSync(
      join(dir, "legacy.yaml"),
      `site: example
name: legacy
type: web-api
strategy: public
pipeline:
  - fetch: { url: "https://example.com/" }
`,
    );

    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync(
        ["-f", "json", "migrate", "schema-v2", "--dry-run", dir],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as Record<string, unknown>;
    const data = env.data as {
      counts: { migrated: number };
      migrated: string[];
    };
    expect(data.counts.migrated).toBe(1);
    expect(data.migrated.some((p) => p.endsWith("legacy.yaml"))).toBe(true);
  });
});
