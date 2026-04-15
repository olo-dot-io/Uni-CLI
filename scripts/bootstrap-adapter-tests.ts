/**
 * Bootstrap script — generate colocated `.test.ts` files (and optional
 * synthetic fixtures) for a hand-picked set of adapters.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-adapter-tests.ts --site hackernews
 *   npx tsx scripts/bootstrap-adapter-tests.ts --site reddit --cmd top
 *   npx tsx scripts/bootstrap-adapter-tests.ts --all
 *   npx tsx scripts/bootstrap-adapter-tests.ts --sites hackernews,arxiv,linear
 *
 * Flags:
 *   --site <name>        generate for one site
 *   --sites a,b,c        generate for listed sites
 *   --cmd <name>         restrict to one command within --site
 *   --all                generate for the default Phase 2 top-50 set
 *   --with-fixtures      also write a minimal synthetic fixture if absent
 *   --force              overwrite existing .test.ts files
 *   --dry                print actions without writing
 *
 * The generated tests import `runAdapterWithFixture`/`expectAdapterShape`
 * from `tests/adapter-runner.ts` and assert the adapter produces the
 * declared columns with ≥1 row. Fixtures still need per-adapter hand
 * shaping when the pipeline does something beyond a single GET — the
 * generic synthetic fixture below only handles the simplest case.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

interface Args {
  sites?: string[];
  cmd?: string;
  all?: boolean;
  withFixtures?: boolean;
  force?: boolean;
  dry?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") out.sites = [argv[++i]];
    else if (a === "--sites") out.sites = argv[++i].split(",").filter(Boolean);
    else if (a === "--cmd") out.cmd = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--with-fixtures") out.withFixtures = true;
    else if (a === "--force") out.force = true;
    else if (a === "--dry") out.dry = true;
  }
  return out;
}

/**
 * Phase 2 default target sites. Ordered by priority in the task spec.
 * Fragile/auth-walled sites (xiaohongshu, wechat, instagram, twitter) are
 * deferred to v0.214.
 */
const DEFAULT_SITES = [
  "hackernews",
  "arxiv",
  "linear",
  "reddit",
  "github-trending",
  "bilibili",
  "zhihu",
  "v2ex",
  "douban",
  "lesswrong",
  "bluesky",
];

interface YamlAdapter {
  site?: string;
  name?: string;
  type?: string;
  strategy?: string;
  pipeline?: unknown[];
  columns?: string[];
  quarantine?: boolean;
  args?: Record<string, { type?: string; default?: unknown }>;
}

function loadYaml(path: string): YamlAdapter | undefined {
  try {
    return yaml.load(readFileSync(path, "utf-8"), {
      schema: yaml.CORE_SCHEMA,
    }) as YamlAdapter;
  } catch {
    return undefined;
  }
}

interface Candidate {
  site: string;
  cmd: string;
  yamlPath: string;
  columns: string[];
  pipeline: unknown[];
  args?: Record<string, { type?: string; default?: unknown }>;
}

/**
 * Known-fragile pipeline patterns. We skip these in auto-bootstrap to
 * avoid generating tests that would fail for reasons unrelated to fixture
 * correctness — engine bugs or adapter shape mismatches that predate this
 * framework.
 */
const BROWSER_STEPS = new Set([
  "navigate",
  "evaluate",
  "click",
  "type",
  "press",
  "scroll",
  "snapshot",
  "tap",
  "extract",
  "intercept",
  "wait",
]);

function isPipelineUnsupported(pipeline: unknown[]): string | null {
  const steps = pipeline as Array<Record<string, unknown>>;
  // Browser-strategy adapters need Chrome; skip in Phase 2.
  for (const step of steps) {
    for (const key of Object.keys(step)) {
      if (BROWSER_STEPS.has(key))
        return `browser step "${key}" requires Chrome`;
    }
  }
  // Template engine splits on `||` inside filter expressions, silently
  // zeroing results. Until the engine gains a dedicated parser, any
  // filter containing `||` is untestable here.
  for (const step of steps) {
    if ("filter" in step) {
      const expr = String(step.filter ?? "");
      if (expr.includes("||")) {
        return "filter expression contains `||` (template pipe-split bug)";
      }
    }
  }
  // Adapters that do two selects on different response shapes (common in
  // GraphQL chains like lesswrong user-posts) can't be synthesised by
  // the generic fixture builder — one body can't satisfy both paths.
  const selectCount = steps.filter((s) => "select" in s).length;
  const fetchCount = steps.filter((s) => "fetch" in s).length;
  if (selectCount >= 2 && fetchCount >= 2) {
    return "multi-fetch multi-select chain (needs hand fixture)";
  }
  // Select on a scalar path (endswith `._id`, `.id`, `.name` followed by
  // no further array) — synthetic row is `{_id: 1}` which is scalar, but
  // downstream fetches expect the scalar to interpolate into a URL.
  // Hard to automate; skip.
  for (const step of steps) {
    if (!("select" in step)) continue;
    const path = String(step.select ?? "");
    if (/\.(id|_id|slug|key)$/.test(path)) {
      return `select ends in scalar path "${path}"`;
    }
  }
  // Adapters whose final producer of rows is `map` WITHOUT a preceding
  // array step surface the raw fetch response — column keys declared in
  // the YAML don't show up on row[0]. Detect: the last non-control step
  // is `map` and no earlier step is `select` on a multi-segment path
  // indicating an array.
  const producerIdx = [...steps]
    .reverse()
    .findIndex((s) => "map" in s || "select" in s || "filter" in s);
  if (producerIdx < 0) return "no producer step";
  const last = steps[steps.length - 1 - producerIdx];
  if ("map" in last) {
    const hasSelectBefore = steps
      .slice(0, steps.length - 1 - producerIdx)
      .some((s) => "select" in s);
    const hasFanOut = steps.filter((s) => "fetch" in s).length >= 2;
    if (!hasSelectBefore && !hasFanOut) {
      return "map on non-array (no select or fan-out before map)";
    }
  }
  return null;
}

function collectCandidates(sites: string[], cmdFilter?: string): Candidate[] {
  const out: Candidate[] = [];
  for (const site of sites) {
    const siteDir = join(ADAPTERS_DIR, site);
    if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) continue;
    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      if (ext !== ".yaml" && ext !== ".yml") continue;
      const cmd = file.slice(0, -ext.length);
      if (cmd.startsWith("_")) continue;
      if (cmdFilter && cmd !== cmdFilter) continue;
      const yamlPath = join(siteDir, file);
      const parsed = loadYaml(yamlPath);
      if (!parsed) continue;
      if (parsed.quarantine === true) continue;
      const type = parsed.type ?? "web-api";
      if (type !== "web-api" && type !== "service") continue;
      if (!Array.isArray(parsed.pipeline)) continue;
      const unsupported = isPipelineUnsupported(parsed.pipeline);
      if (unsupported) continue;
      out.push({
        site,
        cmd,
        yamlPath,
        columns: parsed.columns ?? [],
        pipeline: parsed.pipeline,
        args: parsed.args,
      });
    }
  }
  return out;
}

function testFilePathFor(site: string, cmd: string): string {
  return join(ADAPTERS_DIR, site, `${cmd}.test.ts`);
}

function fixturePathFor(site: string, cmd: string): string {
  return join(FIXTURES_DIR, site, `${cmd}.json`);
}

function testSource(site: string, cmd: string, columns: string[]): string {
  const colJson = JSON.stringify(columns);
  return `import { describe, it } from "vitest";
import {
  runAdapterWithFixture,
  expectAdapterShape,
} from "../../../tests/adapter-runner.js";

describe("${site} ${cmd}", () => {
  it("returns rows with declared columns against fixture", async () => {
    const { output } = await runAdapterWithFixture("${site}", "${cmd}");
    expectAdapterShape(output, {
      columns: ${colJson},
      minItems: 1,
    });
  });
});
`;
}

/**
 * Build a synthetic row object. Fields referenced by common adapter map()
 * templates are populated so the pipeline can successfully surface rows;
 * declared `columns` names are NOT added directly so they cannot overwrite
 * the nested shapes map() expects.
 *
 * This matches the pattern in our adapters where `columns` is what the
 * map() step OUTPUTS, not what the fetch response CONTAINS. The shape
 * assertion then checks that the final transformed rows have the column
 * keys — sourced from these synthetic nested fields.
 */
function syntheticRow(_columns: string[]): Record<string, unknown> {
  return {
    // Hacker News item shape
    by: "alice",
    title: "Synthetic Title",
    score: 42,
    descendants: 5,
    id: 1,
    kids: [1, 2, 3],
    time: 1760000000,
    url: "https://example.com/a",
    text: "synthetic text body",
    points: 42,
    num_comments: 7,
    hits: [{ title: "hit", url: "https://example.com/a" }],

    // Bluesky actor/profile shape
    handle: "alice.bsky.social",
    displayName: "Alice",
    followersCount: 100,
    followsCount: 50,
    postsCount: 10,
    likeCount: 5,
    repostCount: 1,
    replyCount: 0,
    indexedAt: "2026-04-15T00:00:00Z",
    description: "Synthetic description",
    name: "Synthetic Name",
    link: "https://example.com/a",
    topic: "Synthetic Topic",
    likes: 42,
    post: {
      author: { handle: "alice.bsky.social", displayName: "Alice" },
      record: { text: "synthetic post text" },
      likeCount: 5,
      repostCount: 1,
      replyCount: 0,
      indexedAt: "2026-04-15T00:00:00Z",
    },

    // Zhihu/Weibo/Bilibili target shapes
    target: {
      title: "Synthetic target title",
      id: 12345,
      answer_count: 10,
    },
    detail_text: "100 万热度",
    owner: { name: "alice" },
    stat: { view: 1000, danmaku: 10 },
    bvid: "BV1abcdefghi",
    node: { title: "Synthetic Node" },

    // GitHub/Gitlab API shapes
    full_name: "acme/widget",
    stargazers_count: 42,
    forks_count: 7,
    language: "TypeScript",

    // Linear GraphQL shapes
    identifier: "ENG-1",
    state: { name: "In Progress" },
    project: { name: "Synthetic Project" },
    assignee: { name: "alice" },
    priority: 1,
    createdAt: "2026-04-15T00:00:00Z",

    // Bluesky starter pack / feed-item shape
    listItemCount: 10,
    joinedAllTimeCount: 5,
    creator: { handle: "alice.bsky.social" },
    record: {
      name: "Synthetic Pack",
      description: "Synthetic pack description",
      text: "synthetic post text",
    },

    // HN user / bio fields
    karma: 100,
    created: 1600000000,
    about: "synthetic about",

    // V2EX topic shape
    replies: 3,

    // Reddit item wraps under `data`
    data: {
      title: "synthetic-title",
      author: "alice",
      subreddit: "programming",
      subreddit_name_prefixed: "r/programming",
      score: 42,
      num_comments: 7,
      url: "https://example.com/a",
      permalink: "/r/programming/1",
      name: "programming",
      display_name: "programming",
      subscribers: 1000000,
      public_description: "Synthetic subreddit",
      link_karma: 100,
      comment_karma: 200,
      total_karma: 300,
      created_utc: 1600000000,
      body: "synthetic reddit comment",
    },
    link_karma: 100,
    comment_karma: 200,
    total_karma: 300,
    created_utc: 1600000000,

    // Generic numeric counters various adapters touch
    answer_count: 10,
    answers: 10,
    view_count: 1000,
    subscribers: 1000000,
  };
}

function nestUnderPath(path: string, value: unknown): unknown {
  const parts = path.trim().split(".").filter(Boolean);
  let out: unknown = value;
  for (let i = parts.length - 1; i >= 0; i--) {
    out = { [parts[i]]: out };
  }
  return out;
}

/**
 * Generate a synthetic fixture body per step-1 fetch. Decisions:
 *   - Pipeline with `parse_rss` gets an Atom feed.
 *   - Pipeline with a `select:` preceding map wraps the row array under
 *     the matching JSON path.
 *   - Fan-out (`fetch` → `map: id` → `fetch`): first call returns array of
 *     ids, subsequent calls return the synthetic row object. Handled by
 *     separate url_pattern entries.
 */
function buildFixture(
  columns: string[],
  pipeline: unknown[],
): { http_requests: unknown[] } {
  const steps = pipeline as Array<Record<string, unknown>>;
  const row = syntheticRow(columns);

  const hasParseRss = steps.some((s) => "parse_rss" in s);
  if (hasParseRss) {
    const body_text = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.0001v1</id>
    <title>Synthetic arXiv Paper Title</title>
    <author><name>Alice Author</name></author>
    <author><name>Bob Author</name></author>
    <published>2026-04-15T00:00:00Z</published>
    <summary>This is a synthetic paper abstract for fixture testing.</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.0002v1</id>
    <title>Second Synthetic Paper</title>
    <author><name>Carol Author</name></author>
    <published>2026-04-14T00:00:00Z</published>
    <summary>Another synthetic abstract.</summary>
  </entry>
</feed>`;
    return {
      http_requests: [
        {
          url_pattern: ".*",
          response: {
            status: 200,
            headers: { "content-type": "application/atom+xml" },
            body_text,
          },
        },
      ],
    };
  }

  // Detect fan-out: two or more fetch steps where a `map: { id: ... }`
  // step sits between them AND the first fetch URL path looks like an id
  // list endpoint (topstories.json, beststories.json, etc.). First fetch
  // returns an id list; subsequent fetches per item return an object.
  const fetchSteps = steps.filter((s) => "fetch" in s);
  // Find the first fetch and any map step that produces `id:` from a scalar.
  const firstFetchIdx = steps.findIndex((s) => "fetch" in s);
  const secondFetchIdx = steps.findIndex(
    (s, i) => i > firstFetchIdx && "fetch" in s,
  );
  let hasFanOut = false;
  if (firstFetchIdx >= 0 && secondFetchIdx > firstFetchIdx) {
    const between = steps.slice(firstFetchIdx + 1, secondFetchIdx);
    const hasIdMap = between.some((s) => {
      if (!("map" in s)) return false;
      const m = s.map as Record<string, unknown>;
      return (
        typeof m === "object" &&
        m !== null &&
        "id" in m &&
        /\$\{\{\s*item\s*\}\}/.test(String(m.id))
      );
    });
    if (hasIdMap) hasFanOut = true;
  }
  void fetchSteps;

  if (hasFanOut) {
    // The first fetch in HN-style adapters returns `[1, 2, 3]`. Individual
    // item fetches return an object with id. Build two patterns: one for
    // the list URL, one for item URLs.
    const firstFetchUrl = String(
      (fetchSteps[0].fetch as Record<string, unknown>).url ?? "",
    );
    const firstHost = firstFetchUrl
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .replace(/\./g, "\\.");
    const firstPath = firstFetchUrl
      .replace(/^https?:\/\/[^/]+/, "")
      .split("?")[0]
      .replace(/\$\{\{[^}]+\}\}/g, "[^/?]+")
      .replace(/\./g, "\\.");
    const firstPattern = `${firstHost}${firstPath}`;
    return {
      http_requests: [
        {
          url_pattern: firstPattern,
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body_json: [1, 2, 3],
          },
        },
        {
          url_pattern: ".*",
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body_json: row,
          },
        },
      ],
    };
  }

  // Single-fetch path: optionally nest the row array under a select path.
  const selectStep = steps.find((s) => "select" in s);
  let body: unknown = [row, row, row];
  if (selectStep) {
    const selectPath = String(selectStep.select ?? "").trim();
    if (selectPath && !selectPath.includes("$")) {
      body = nestUnderPath(selectPath, body);
    }
  } else {
    // No select — single object result. The map step is a no-op on
    // non-array data, so the raw response is what gets surfaced. For
    // adapters that declare columns and rely on map(), we synthesise an
    // array anyway; the shape check asserts against row[0].
    body = row;
  }
  return {
    http_requests: [
      {
        url_pattern: ".*",
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          ...(typeof body === "string"
            ? { body_text: body }
            : { body_json: body }),
        },
      },
    ],
  };
}

function syntheticFixture(
  site: string,
  cmd: string,
  columns: string[],
  pipeline: unknown[],
): string {
  const { http_requests } = buildFixture(columns, pipeline);
  const fixture = {
    version: 1,
    recorded_at: new Date().toISOString(),
    args: {},
    http_requests,
    expected: {
      columns,
      minItems: 1,
    },
  };
  void site;
  void cmd;
  return JSON.stringify(fixture, null, 2) + "\n";
}

interface Report {
  wrote: string[];
  skipped: string[];
}

function run(args: Args): Report {
  const sites = args.all ? DEFAULT_SITES : (args.sites ?? DEFAULT_SITES);
  const candidates = collectCandidates(sites, args.cmd);
  const wrote: string[] = [];
  const skipped: string[] = [];

  for (const c of candidates) {
    const tPath = testFilePathFor(c.site, c.cmd);
    if (!args.force && existsSync(tPath)) {
      skipped.push(`${c.site}/${c.cmd}.test.ts (exists)`);
    } else if (c.columns.length === 0) {
      skipped.push(`${c.site}/${c.cmd}.test.ts (no columns)`);
    } else {
      const src = testSource(c.site, c.cmd, c.columns);
      if (args.dry) {
        wrote.push(`[dry] ${tPath}`);
      } else {
        mkdirSync(dirname(tPath), { recursive: true });
        writeFileSync(tPath, src, "utf-8");
        wrote.push(tPath);
      }
    }

    if (args.withFixtures) {
      const fPath = fixturePathFor(c.site, c.cmd);
      // `hand_tuned: true` in an existing fixture opts out of overwrite
      // even when --force is passed. Lets us keep a few carefully
      // authored fixtures while still regenerating the synthetic mass.
      let handTuned = false;
      if (existsSync(fPath)) {
        try {
          const current = JSON.parse(readFileSync(fPath, "utf-8")) as {
            hand_tuned?: boolean;
          };
          handTuned = current.hand_tuned === true;
        } catch {
          /* treat as regeneratable */
        }
      }
      if (handTuned) {
        skipped.push(`${c.site}/${c.cmd}.json fixture (hand-tuned)`);
      } else if (!args.force && existsSync(fPath)) {
        skipped.push(`${c.site}/${c.cmd}.json fixture (exists)`);
      } else {
        const src = syntheticFixture(c.site, c.cmd, c.columns, c.pipeline);
        if (args.dry) {
          wrote.push(`[dry] ${fPath}`);
        } else {
          mkdirSync(dirname(fPath), { recursive: true });
          writeFileSync(fPath, src, "utf-8");
          wrote.push(fPath);
        }
      }
    }
  }

  return { wrote, skipped };
}

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);
if (!parsed.sites && !parsed.all) {
  console.error(
    "usage: bootstrap-adapter-tests.ts --site <name> | --sites a,b,c | --all [--cmd x] [--with-fixtures] [--force] [--dry]",
  );
  process.exit(2);
}
const report = run(parsed);
for (const path of report.wrote) console.log(`wrote   ${path}`);
for (const path of report.skipped) console.log(`skipped ${path}`);
console.log(`\nwrote ${report.wrote.length}, skipped ${report.skipped.length}`);
