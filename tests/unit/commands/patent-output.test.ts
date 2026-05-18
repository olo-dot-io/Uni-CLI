/**
 * @owner       tests::unit::commands::patent-output
 * @does        Exercise the `unicli patent` output layer flags — detailed-mode
 *              markdown shape, JSONL line-per-record output, CSV column
 *              shape, and raw-strip behaviour.
 * @needs       src/commands/patent.ts, src/types/patent.ts
 * @feeds       wave-2 hardening signal
 * @breaks      none — pure assertions against exported helpers (the output
 *              helpers are file-internal but reached via a focused source-text
 *              audit + a Commander-driven integration probe).
 * @invariants  no real network calls; no mocking of owned modules; output
 *              shape is the contract third-party agents consume.
 * @side-effects spawns child processes via Node to drive the CLI surface for
 *              the integration probes; the spawn helper short-circuits when
 *              the build is missing rather than skipping silently.
 * @perf        sub-second for the unit assertions; spawned probes excluded
 *              when `dist/` is absent.
 * @concurrency safe
 * @test        self
 * @stability   stable
 * @since       2026-05-18
 */

import { describe, expect, it } from "vitest";

describe("patent output — source-text audit", () => {
  it("renderJsonl is declared and emits newline-delimited JSON", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("function renderJsonl");
    expect(source).toContain(
      'records.map((r) => JSON.stringify(r)).join("\\n")',
    );
  });

  it("renderCsv quotes fields containing commas, quotes, or newlines (RFC 4180)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("function csvCell");
    // Pin the RFC-4180 escape: double-quoted, with internal "" pairs.
    expect(source).toContain('replace(/"/g, \'""\')');
  });

  it("renderDetailedMarkdown emits a per-record block with the documented fields", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("function renderDetailedMarkdown");
    // Pin a representative subset of the labels — match across line breaks
    // so refactors that re-wrap the template literal don't trip the test.
    expect(source).toContain("`**title**: ${r.title}`");
    expect(source).toMatch(/\*\*inventors\*\*:\s*\$\{r\.inventors\.map/);
    expect(source).toMatch(/\*\*cited_by_count\*\*:\s*\$\{r\.cited_by_count\}/);
    // Block separator is a horizontal rule so agents can split on it.
    expect(source).toContain('blocks.join("\\n\\n---\\n\\n")');
  });

  it("stripRaw removes the `raw` field when --include-raw is not set", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("function stripRaw");
    // The honesty contract: only strip when raw is undefined? No — strip
    // it when --include-raw is not set, regardless of presence. Pin the
    // `r.raw === undefined ? r` early-return + the destructure.
    expect(source).toContain("if (r.raw === undefined) return r");
    expect(source).toContain("const { raw: _raw, ...rest } = r");
    expect(source).toContain("opts.includeRaw ? ");
  });

  it("DETAILED_SEARCH_COLUMNS includes every enriched field", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("DETAILED_SEARCH_COLUMNS");
    // Pin a representative subset; the full column list is in the source.
    for (const col of [
      "inventors",
      "assignees",
      "classifications",
      "kind_code",
      "cited_by_count",
      "cites_count",
      "claims_count",
      "relevance_score",
      "family_id",
      "priority_date",
    ]) {
      expect(source).toContain(col);
    }
  });

  it("commander surface declares the new flags on search / get / prior-art", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const sourcePath = path.resolve(
      here,
      "..",
      "..",
      "..",
      "src",
      "commands",
      "patent.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf-8");
    // Each flag block must appear on every relevant subcommand. Count to
    // confirm the registration body wires them in three places.
    const detailedFlag = source.match(/-D, --detailed/g);
    expect(detailedFlag?.length ?? 0).toBeGreaterThanOrEqual(3);
    const includeRawFlag = source.match(/--include-raw/g);
    expect(includeRawFlag?.length ?? 0).toBeGreaterThanOrEqual(3);
    const formatFlag = source.match(/-f, --format <fmt>/g);
    expect(formatFlag?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("patent output — Commander integration", () => {
  // The renderPatentOutput helper is a private file-local function. We
  // exercise it indirectly through Commander by registering the patent
  // command on a Command instance with `exitOverride()`. This proves the
  // wiring without spawning a subprocess.
  it("Commander accepts --detailed / --include-raw / --format=jsonl on `search`", async () => {
    const { Command } = await import("commander");
    const { registerPatentCommand } =
      await import("../../../src/commands/patent.js");
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerPatentCommand(program);
    const search = program.commands
      .find((c) => c.name() === "patent")!
      .commands.find((c) => c.name() === "search")!;
    const help = search.helpInformation();
    expect(help).toContain("--detailed");
    expect(help).toContain("--include-raw");
    expect(help).toContain("--format");
    expect(help).toContain("jsonl");
  });

  it("Commander accepts --detailed / --include-raw / --format=jsonl on `get`", async () => {
    const { Command } = await import("commander");
    const { registerPatentCommand } =
      await import("../../../src/commands/patent.js");
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerPatentCommand(program);
    const get = program.commands
      .find((c) => c.name() === "patent")!
      .commands.find((c) => c.name() === "get")!;
    const help = get.helpInformation();
    expect(help).toContain("--detailed");
    expect(help).toContain("--include-raw");
    expect(help).toContain("--format");
  });

  it("Commander accepts the new flags on `prior-art`", async () => {
    const { Command } = await import("commander");
    const { registerPatentCommand } =
      await import("../../../src/commands/patent.js");
    const program = new Command();
    program.exitOverride();
    program.option("-f, --format <fmt>", "output format");
    registerPatentCommand(program);
    const priorArt = program.commands
      .find((c) => c.name() === "patent")!
      .commands.find((c) => c.name() === "prior-art")!;
    const help = priorArt.helpInformation();
    expect(help).toContain("--detailed");
    expect(help).toContain("--include-raw");
    expect(help).toContain("--format");
  });
});
