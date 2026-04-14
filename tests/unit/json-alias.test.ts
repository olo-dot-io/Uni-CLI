import { describe, it, expect, afterEach } from "vitest";
import { Command } from "commander";
import { applyJsonAlias } from "../../src/cli.js";

/**
 * Contract:
 *   - `--json` is a boolean alias for `-f json`
 *   - Invoking it sets format="json" on the root program
 *   - Invoking it emits a single stderr warning mentioning v0.213 removal
 *   - If the caller also passed `-f <other>` explicitly, we leave it alone
 *     (explicit beats alias) — this keeps the alias conservative
 */

function captureStderr(): { stop: () => string } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    chunks.push(
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Buffer).toString(),
    );
    return true;
  }) as typeof process.stderr.write;
  return {
    stop() {
      process.stderr.write = orig;
      return chunks.join("");
    },
  };
}

describe("--json deprecation alias", () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  it("applyJsonAlias sets format=json on the root program", () => {
    const program = new Command();
    program.option("-f, --format <fmt>", "format");
    program.option("--json", "alias", false);

    // Build a subcommand so we exercise the "walk to root" logic
    const sub = program.command("demo").action(() => {});

    const cap = captureStderr();
    restore = () => {
      cap.stop();
    };

    applyJsonAlias(sub);

    expect(program.opts().format).toBe("json");
    const stderr = cap.stop();
    restore = null;
    expect(stderr).toContain("[deprecation] --json is deprecated");
    expect(stderr).toContain("v0.213");
  });

  it("preserves an explicit -f <format> value", () => {
    const program = new Command();
    program.option("-f, --format <fmt>", "format");
    program.option("--json", "alias", false);
    program.setOptionValue("format", "yaml");

    const cap = captureStderr();
    restore = () => {
      cap.stop();
    };

    applyJsonAlias(program);

    expect(program.opts().format).toBe("yaml");
    const stderr = cap.stop();
    restore = null;
    // Warning still fires — user used the deprecated flag even if a newer
    // explicit value wins. That keeps the migration signal loud.
    expect(stderr).toContain("[deprecation]");
  });

  it("writes the warning to stderr, not stdout", () => {
    const program = new Command();
    program.option("-f, --format <fmt>", "format");

    const stdoutChunks: string[] = [];
    const origStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown): boolean => {
      stdoutChunks.push(
        typeof c === "string" ? c : Buffer.from(c as Buffer).toString(),
      );
      return true;
    }) as typeof process.stdout.write;

    const cap = captureStderr();
    restore = () => {
      cap.stop();
      process.stdout.write = origStdout;
    };

    applyJsonAlias(program);

    const stderr = cap.stop();
    process.stdout.write = origStdout;
    restore = null;

    expect(stderr).toContain("[deprecation]");
    expect(stdoutChunks.join("")).not.toContain("deprecation");
  });
});
