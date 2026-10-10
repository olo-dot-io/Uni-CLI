import { readManifest } from "../../src/fast-path/manifest.js";
import { manifestSearchDocuments } from "../../src/fast-path/handlers/discovery.js";
import {
  buildIndexFromDocuments,
  searchDocuments,
} from "../../src/discovery/search.js";

process.env.UNICLI_DYNAMIC_MACOS = "0";

const documents = manifestSearchDocuments(readManifest());
const failures: string[] = [];
const naturalLanguageQueries = [
  "agent search computer use recent memes and discussion",
  "toggle volume",
  "compare prices",
  "render frames",
  "stock ticker",
  "speech codec",
];

for (const query of naturalLanguageQueries) {
  const results = searchDocuments(documents, query, 8);
  const spurious = results.filter((result) =>
    result.ranking.signals.includes("site:unique-typo"),
  );
  if (spurious.length > 0) {
    failures.push(
      `${query} promoted ${spurious.map((r) => r.site).join(", ")}`,
    );
  }
}

const recentDiscussionQueries = [
  "search recent community discussions about distributed databases",
  "find latest reactions to electric vehicles",
  "查询近期关于数字图书馆的讨论",
];
for (const query of recentDiscussionQueries) {
  const [result] = searchDocuments(documents, query, 1);
  if (result?.site !== "retrieval" || result.command !== "search") {
    failures.push(`${query} failed to route unscoped web research`);
  }
}

for (const query of [
  "reddit search recent database discussions",
  "search local repository recent discussions",
  "search recent weather forecasts",
]) {
  const results = searchDocuments(documents, query, 8);
  if (
    results.some(
      (result) =>
        result.site === "retrieval" &&
        result.ranking.signals.includes("intent:workflow"),
    )
  ) {
    failures.push(`${query} received an unrelated community research boost`);
  }
}

for (const [query, site, command] of [
  ["twiter search", "twitter", "search"],
  ["bilibi hot", "bilibili", "hot"],
  ["推特热门", "twitter", "trending"],
  ["reddit search", "reddit", "search"],
  ["hacker news top stories", "hackernews", "top"],
]) {
  const results = searchDocuments(documents, query, 3);
  if (
    !results.some(
      (result) => result.site === site && result.command === command,
    )
  ) {
    failures.push(
      `${query} omitted ${site}/${command} from the first three results`,
    );
  }
}

const domainQueries = [
  {
    query: "distill failed run traces into evolution evidence",
    commands: ["runs/distill"],
    limit: 1,
  },
  {
    query: "inspect evidence from recorded run traces",
    commands: ["runs/list"],
    limit: 1,
  },
  {
    query: "replay failed runs with evidence",
    commands: ["runs/replay"],
    limit: 1,
  },
  {
    query: "inspect recorded run trace browser lease evidence",
    commands: ["runs/list", "runs/show"],
    limit: 5,
  },
  {
    query: "trace academic paper evidence",
    commands: ["scholar/trace"],
    limit: 1,
  },
  {
    query: "arxiv search papers about run traces",
    commands: ["arxiv/search"],
    limit: 3,
  },
  {
    query: "scholar reproduce paper run trace",
    commands: ["scholar/reproduce"],
    limit: 1,
  },
];
for (const { query, commands, limit } of domainQueries) {
  const results = searchDocuments(documents, query, limit);
  const discovered = new Set(
    results.map((result) => `${result.site}/${result.command}`),
  );
  if (commands.some((command) => !discovered.has(command))) {
    failures.push(
      `${query} failed to preserve its execution or academic domain`,
    );
  }
}

const evolvingDocuments = [
  {
    site: "compute",
    command: "apps",
    description: "List desktop applications",
  },
  {
    site: "reference",
    command: "search",
    description: "Search published tutorials",
  },
];
const before = searchDocuments(evolvingDocuments, "computer", 3);
evolvingDocuments[1].description = "Search computer tutorials";
const after = searchDocuments(evolvingDocuments, "computer", 3);
if (
  !before.some((result) => result.ranking.signals.includes("site:unique-typo"))
) {
  failures.push("Unknown vocabulary lost bounded provider typo recovery");
}
if (
  after.some((result) => result.ranking.signals.includes("site:unique-typo"))
) {
  failures.push(
    "Updated catalog vocabulary retained a stale provider typo boost",
  );
}

const index = buildIndexFromDocuments(documents);
const oversizedWord = "catalogvocabulary".repeat(512);
if (
  index.siteResolver.resolve(oversizedWord, [oversizedWord]).fuzzy.length > 0
) {
  failures.push("A word beyond every provider length received a typo match");
}
console.log(
  JSON.stringify(
    {
      catalog_documents: index.N,
      scenarios:
        naturalLanguageQueries.length +
        recentDiscussionQueries.length +
        11 +
        domainQueries.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
