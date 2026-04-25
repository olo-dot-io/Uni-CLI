import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import { getAdapter } from "../../src/registry.js";
import { extractTsRegistrations } from "../../scripts/manifest-ts-scan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const REDDIT_BROWSER_TS_COMMANDS = [
  "search",
  "hot",
  "frontpage",
  "popular",
  "new",
  "top",
  "rising",
  "subreddit",
  "trending",
];
const LINUX_DO_BROWSER_TS_COMMANDS = ["search"];

describe("high-value social adapter quality gates", () => {
  it("uses a browser-backed Reddit search command instead of blocked public JSON", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    const reddit = getAdapter("reddit");
    const search = reddit?.commands.search;

    expect(reddit?.strategy).toBe("cookie");
    expect(reddit?.browser).toBe(true);
    expect(search?.browser).toBe(true);
    expect(search?.adapterArgs?.map((arg) => arg.name)).toEqual([
      "query",
      "subreddit",
      "sort",
      "time",
      "limit",
    ]);
  });

  it("exposes GitHub repository search as a typed bridge command", () => {
    loadAllAdapters();

    const gh = getAdapter("gh");
    const searchRepos = gh?.commands["search-repos"];

    expect(searchRepos?.adapterArgs?.map((arg) => arg.name)).toEqual([
      "query",
      "limit",
      "sort",
      "order",
      "language",
    ]);
  });

  it("keeps every browser-backed Reddit TS command visible to the generated manifest", () => {
    const source = readFileSync(
      join(ROOT, "src", "adapters", "reddit", "listings.ts"),
      "utf-8",
    );
    const commandNames = extractTsRegistrations(
      source,
      "reddit",
      "listings",
    ).flatMap((registration) =>
      registration.site === "reddit"
        ? registration.commands.map((command) => command.name)
        : [],
    );

    expect(commandNames).toEqual(
      expect.arrayContaining([
        "hot",
        "frontpage",
        "popular",
        "new",
        "top",
        "rising",
        "subreddit",
        "trending",
      ]),
    );
    expect(commandNames).not.toContain("listings");
  });

  it("does not keep stale public Reddit YAML adapters behind browser TS replacements", () => {
    for (const command of REDDIT_BROWSER_TS_COMMANDS) {
      expect(
        existsSync(join(ROOT, "src", "adapters", "reddit", `${command}.yaml`)),
        `${command}.yaml must not shadow the browser-backed TS implementation`,
      ).toBe(false);
    }
  });

  it("uses browser-backed Linux.do search instead of rate-limited public JSON", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    const linuxDo = getAdapter("linux-do");
    const search = linuxDo?.commands.search;

    expect(search?.strategy).toBe("cookie");
    expect(search?.browser).toBe(true);
    expect(search?.adapterArgs?.map((arg) => arg.name)).toEqual([
      "query",
      "limit",
    ]);
    for (const command of LINUX_DO_BROWSER_TS_COMMANDS) {
      expect(
        existsSync(
          join(ROOT, "src", "adapters", "linux-do", `${command}.yaml`),
        ),
        `${command}.yaml must not shadow the browser-backed TS implementation`,
      ).toBe(false);
    }
  });
});
