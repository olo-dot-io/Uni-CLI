import { describe, it, expect } from "vitest";
import { loadAdaptersFromDir } from "../../src/discovery/loader.js";
import { getAllAdapters, listCommands } from "../../src/registry.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

describe("adapter loader", () => {
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

  it("loads hackernews adapter with all 8 commands", () => {
    const adapters = getAllAdapters();
    const hn = adapters.find((a) => a.name === "hackernews");
    expect(hn).toBeDefined();
    expect(Object.keys(hn!.commands).sort()).toEqual(
      ["ask", "best", "jobs", "new", "search", "show", "top", "user"].sort(),
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

  it("loads bluesky adapter with all 9 commands", () => {
    const adapters = getAllAdapters();
    const bsky = adapters.find((a) => a.name === "bluesky");
    expect(bsky).toBeDefined();
    expect(Object.keys(bsky!.commands).length).toBe(9);
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

  it("detects adapter types correctly", () => {
    const adapters = getAllAdapters();
    const ollama = adapters.find((a) => a.name === "ollama");
    expect(ollama?.type).toBe("service");

    const blender = adapters.find((a) => a.name === "blender");
    expect(blender?.type).toBe("desktop");
  });
});
