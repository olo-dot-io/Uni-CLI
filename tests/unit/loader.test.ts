import { beforeAll, describe, it, expect, vi } from "vitest";
import {
  loadAdaptersFromDir,
  loadTsAdapters,
  primeKernelCache,
} from "../../src/discovery/loader.js";
import { getAllAdapters, listCommands } from "../../src/registry.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildInvocation, execute } from "../../src/engine/kernel/execute.js";
import { buildCommandContract } from "../../src/core/command-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

describe("adapter loader", () => {
  beforeAll(async () => {
    loadAdaptersFromDir(ADAPTERS_DIR);
    await loadTsAdapters({ strict: true });
  });

  it("loads all built-in YAML adapters without error", () => {
    const count = loadAdaptersFromDir(ADAPTERS_DIR);
    expect(count).toBeGreaterThan(0);
  });

  it("registers adapters to the global registry", () => {
    const adapters = getAllAdapters();
    expect(adapters.length).toBeGreaterThan(0);
  });

  it("lists commands across all adapters", () => {
    const commands = listCommands();
    expect(commands.length).toBeGreaterThan(0);

    // Every command should have a site and command name
    for (const cmd of commands) {
      expect(cmd.site).toBeTruthy();
      expect(cmd.command).toBeTruthy();
    }
  });

  it("keeps every resolved read-family command semantically read-only", () => {
    const mismatches: string[] = [];
    for (const adapter of getAllAdapters()) {
      for (const [commandName, command] of Object.entries(adapter.commands)) {
        const contract = buildCommandContract({
          adapter,
          commandName,
          command,
        });
        if (
          ["search", "get", "list"].includes(contract.operation.family) &&
          contract.effect.operation_effect !== "read"
        ) {
          mismatches.push(`${adapter.name}/${commandName}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("surfaces adapter categories in registry command rows", () => {
    loadAdaptersFromDir(ADAPTERS_DIR);

    const arxivCommands = listCommands().filter((cmd) => cmd.site === "arxiv");
    expect(arxivCommands.length).toBeGreaterThan(0);
    expect(arxivCommands.every((cmd) => cmd.category === "scholarly")).toBe(
      true,
    );
  });

  it("loads hackernews adapter with all 11 commands", () => {
    const adapters = getAllAdapters();
    const hn = adapters.find((a) => a.name === "hackernews");
    expect(hn).toBeDefined();
    expect(Object.keys(hn!.commands).sort()).toEqual(
      [
        "ask",
        "best",
        "comments",
        "item",
        "jobs",
        "new",
        "read",
        "search",
        "show",
        "top",
        "user",
      ].sort(),
    );
  });

  it("loads reddit adapter with multiple commands", () => {
    const adapters = getAllAdapters();
    const reddit = adapters.find((a) => a.name === "reddit");
    expect(reddit).toBeDefined();
    const cmds = Object.keys(reddit!.commands);
    expect(cmds).toContain("hot");
    expect(cmds).toContain("search");
    expect(cmds).toContain("subreddit");
    expect(cmds).toContain("user");
  });

  it("loads Bluesky API and official goat commands", () => {
    const adapters = getAllAdapters();
    const bsky = adapters.find((a) => a.name === "bluesky");
    expect(bsky).toBeDefined();
    expect(Object.keys(bsky!.commands).length).toBe(16);
    expect(bsky!.commands["native-resolve"]?.execution_operator).toBe(
      "native-cli",
    );
  });

  it("parses adapter args correctly", () => {
    const adapters = getAllAdapters();
    const hn = adapters.find((a) => a.name === "hackernews");
    const searchCmd = hn?.commands["search"];
    expect(searchCmd).toBeDefined();

    const queryArg = searchCmd!.adapterArgs?.find((a) => a.name === "query");
    expect(queryArg).toBeDefined();
    expect(queryArg!.required).toBe(true);
    expect(queryArg!.positional).toBe(true);
  });

  it("parses Hugging Face daily paper limit as an integer", () => {
    loadAdaptersFromDir(ADAPTERS_DIR);

    const adapters = getAllAdapters();
    const hfPapers = adapters.find((a) => a.name === "huggingface-papers");
    const dailyCmd = hfPapers?.commands["daily"];
    const limitArg = dailyCmd?.adapterArgs?.find((a) => a.name === "limit");

    expect(limitArg).toMatchObject({
      type: "int",
      default: 20,
    });
  });

  it("preserves YAML bounds and rejects invalid input before acquiring HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-yaml-bounds-"));
    const siteDir = join(root, "yaml-bounds-fixture");
    mkdirSync(siteDir);
    writeFileSync(
      join(siteDir, "read.yaml"),
      `site: yaml-bounds-fixture
name: read
description: Bounds validation fixture
type: web-api
strategy: public
operation_effect: read
args:
  query:
    type: str
    required: true
    minLength: 3
    maxLength: 5
    pattern: "^[a-z]+$"
  limit:
    type: int
    minimum: 1
    maximum: 3
pipeline:
  - fetch:
      url: https://example.com/should-not-run
capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
schema_version: v2
`,
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(loadAdaptersFromDir(root, "runtime")).toBe(1);
      primeKernelCache();
      const command = getAllAdapters().find(
        (adapter) => adapter.name === "yaml-bounds-fixture",
      )?.commands.read;
      expect(command?.adapterArgs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "query",
            minLength: 3,
            maxLength: 5,
            pattern: "^[a-z]+$",
          }),
          expect.objectContaining({
            name: "limit",
            minimum: 1,
            maximum: 3,
          }),
        ]),
      );

      const invocation = buildInvocation("cli", "yaml-bounds-fixture", "read", {
        args: { query: "X", limit: 0 },
        source: "shell",
      });
      expect(invocation).not.toBeNull();
      const result = await execute(invocation!);
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toMatchObject({
        code: "invalid_input",
        stage: "validate",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stamps YAML and TypeScript commands with repairable source paths", async () => {
    loadAdaptersFromDir(ADAPTERS_DIR);
    await loadTsAdapters({ strict: true });

    const adapters = getAllAdapters();
    const hackernews = adapters.find(
      (adapter) => adapter.name === "hackernews",
    );

    expect(hackernews?.commands["top"].adapter_path).toBe(
      "src/adapters/hackernews/top.yaml",
    );
    expect(hackernews?.commands["read"].adapter_path).toBe(
      "src/adapters/hackernews/read.ts",
    );
  });

  it("stamps dynamically registered TypeScript commands with repairable source paths", async () => {
    loadAdaptersFromDir(ADAPTERS_DIR);
    await loadTsAdapters();

    const adapters = getAllAdapters();
    const anilist = adapters.find((adapter) => adapter.name === "anilist");
    const notion = adapters.find((adapter) => adapter.name === "notion-app");

    expect(anilist?.commands["characters"].adapter_path).toBe(
      "src/adapters/anilist/web.ts",
    );
    expect(notion?.commands["read"].adapter_path).toBe(
      "src/adapters/notion-app/notion-app.ts",
    );
  });

  it("detects adapter types correctly", () => {
    const adapters = getAllAdapters();
    const ollama = adapters.find((a) => a.name === "ollama");
    expect(ollama?.type).toBe("service");

    const blender = adapters.find((a) => a.name === "blender");
    expect(blender?.type).toBe("desktop");
  });
});
