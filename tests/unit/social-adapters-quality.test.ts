import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import { getAdapter } from "../../src/registry.js";
import { buildSocialAudit } from "../../src/social/capabilities.js";

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
const TWITTER_USER_TIMELINE_TS_COMMANDS = [
  "tweets",
  "user-tweets",
  "user-timeline",
  "list-tweets",
];

describe("high-value social adapter quality gates", () => {
  beforeAll(async () => {
    loadAllAdapters();
    await loadTsAdapters();
  });

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

  it("keeps every browser-backed Reddit TS command in the authoritative registry", () => {
    const commandNames = Object.keys(getAdapter("reddit")?.commands ?? {});

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

  it("keeps every Twitter/X user timeline TS command in the authoritative registry", () => {
    const commandNames = Object.keys(getAdapter("twitter")?.commands ?? {});

    expect(commandNames).toEqual(
      expect.arrayContaining(TWITTER_USER_TIMELINE_TS_COMMANDS),
    );
  });

  it("keeps the Twitter/X comments command in the authoritative registry", () => {
    const twitter = getAdapter("twitter");
    const commands = ["thread", "comments"].map(
      (name) => twitter?.commands[name],
    );

    expect(commands.map((command) => command?.name)).toEqual(
      expect.arrayContaining(["thread", "comments"]),
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "comments",
          strategy: "cookie",
          domain: "x.com",
        }),
      ]),
    );
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

  it("keeps Twitter/X complete against the required social capability audit", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    const twitter = getAdapter("twitter");
    const row = buildSocialAudit(twitter ? [twitter] : []).find(
      (item) => item.site === "twitter",
    );

    expect(row?.missing).toEqual([]);
  });

  it("exposes platform-specific subtitle extraction for major video social sites", async () => {
    loadAllAdapters();
    await loadTsAdapters();

    for (const site of ["youtube", "facebook", "instagram", "tiktok"]) {
      const command = getAdapter(site)?.commands.subtitles;
      expect(command, `${site} subtitles command`).toBeDefined();
      expect(command?.adapterArgs?.map((arg) => arg.name)).toEqual([
        "url",
        "languages",
        "cookies-from-browser",
      ]);
      expect(command?.columns).toEqual(["language", "text", "path"]);
      expect(command?.defaultFormat).toBe("json");
      expect(command?.socialCapabilities).toEqual(
        expect.arrayContaining(["read", "media", "subtitles"]),
      );
    }
  });
});
