/**
 * Compare the complete frozen discovery implementation with the working tree,
 * lexical ablations, and the installed MiniSearch BM25+ implementation.
 * Run with node --import tsx bench/search-baselines.ts.
 * BENCH_RUNS controls resident repetitions, BENCH_COLD_RUNS fresh processes.
 * SEARCH_BASELINE_REF defaults to a3ccd598. No benchmark weights are fitted.
 * Writes bench/search-baselines.results.json and the same JSON to stdout.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import MiniSearch from "minisearch";
import ts from "@typescript/typescript6";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import { runtimeSearchDocuments } from "../src/discovery/search.js";
import type {
  CommandSearchDocument,
  SearchIndex,
  SearchResult,
} from "../src/discovery/search.js";
import { isCommandDiscoverable } from "../src/core/command-availability.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselineRef = process.env.SEARCH_BASELINE_REF ?? "a3ccd598";
const repetitions = Number(process.env.BENCH_RUNS ?? 5);
const coldRuns = Number(process.env.BENCH_COLD_RUNS ?? 9);
if (
  !Number.isInteger(repetitions) ||
  repetitions < 1 ||
  !Number.isInteger(coldRuns) ||
  coldRuns < 0
) {
  throw new Error(
    "BENCH_RUNS must be positive and BENCH_COLD_RUNS nonnegative integers",
  );
}

type Hit = { id: string; score: number };
type Case = { query: string; accepted: string[]; group: string };
type TokenizedDocument = {
  termCount: number;
  termFrequencies: Map<string, number>;
};
type Engine = {
  buildIndexFromDocuments(documents: CommandSearchDocument[]): SearchIndex;
  benchmarkSearchIndex(
    index: SearchIndex,
    query: string,
    limit: number,
    options: object,
  ): SearchResult[];
  benchmarkTokenizeDocument(
    siteTerms: string[],
    site: string,
    command: string,
    description: string,
    category?: string,
  ): TokenizedDocument;
  benchmarkQueryTerms(query: string): string[];
};
type Ranker = { name: string; search(query: string): Hit[]; build_ms: number };

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round(
      (sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0) *
        1000,
    ) / 1000
  );
}

// Read literal test data without importing Vitest or executing test source.
function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((entry) => literal(entry as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isIdentifier(property.name)
        ) {
          throw new Error(
            "Evaluation data must contain named literal properties",
          );
        }
        return [property.name.text, literal(property.initializer)];
      }),
    );
  }
  throw new Error(`Unsupported evaluation literal ${ts.SyntaxKind[node.kind]}`);
}

function evaluationData(source: string): {
  cases: Case[];
  negatives: string[];
} {
  const file = ts.createSourceFile(
    "search-eval.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const values = new Map<string, unknown>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ["EVAL_CASES", "NEGATIVE_QUERIES"].includes(declaration.name.text)
      ) {
        values.set(declaration.name.text, literal(declaration.initializer));
      }
    }
  }
  const cases = values.get("EVAL_CASES") as Array<{
    query: string;
    site: string;
    command: string;
    alsoAccepted?: Array<{ site: string; command: string }>;
  }>;
  const negatives = values.get("NEGATIVE_QUERIES") as string[];
  if (!cases || !negatives)
    throw new Error("Frozen evaluation data was not found");
  return {
    cases: cases.map((entry) => ({
      query: entry.query,
      accepted: [entry, ...(entry.alsoAccepted ?? [])].map(
        (pair) => `${pair.site}/${pair.command}`,
      ),
      group: /[\u4e00-\u9fff]/u.test(entry.query) ? "zh" : "en",
    })),
    negatives,
  };
}

async function snapshotEngine(
  directory: string,
  revision?: string,
): Promise<Engine> {
  if (revision) {
    const archive = execFileSync(
      "git",
      [
        "archive",
        "--format=tar",
        revision,
        "src",
        "package.json",
        "tsconfig.json",
      ],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    execFileSync("tar", ["-x", "-C", directory], { input: archive });
  } else {
    cpSync(join(root, "src"), join(directory, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(directory, "package.json"));
    cpSync(join(root, "tsconfig.json"), join(directory, "tsconfig.json"));
  }
  symlinkSync(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  // Visibility-only instrumentation applies equally to each complete snapshot.
  // Ranking, aliases, intent, feasibility, and registry code stay at that revision.
  const entry = join(directory, "src/discovery/search.ts");
  appendFileSync(
    entry,
    `\nexport { searchIndex as benchmarkSearchIndex, tokenizeDocument as benchmarkTokenizeDocument };\nexport function benchmarkQueryTerms(query: string): string[] { return [...new Set(tokenizeQuery(query).flatMap(expandToken).map(term => term.toLowerCase()))]; }\n`,
  );
  await build({
    entryPoints: [entry],
    outfile: join(directory, "engine.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  return import(
    pathToFileURL(join(directory, "engine.mjs")).href
  ) as Promise<Engine>;
}

function fullRanker(
  name: string,
  engine: Engine,
  documents: CommandSearchDocument[],
): Ranker {
  const start = performance.now();
  const index = engine.buildIndexFromDocuments(documents);
  return {
    name,
    build_ms: performance.now() - start,
    search: (query) =>
      engine
        .benchmarkSearchIndex(index, query, 5, {})
        .map((hit) => ({ id: `${hit.site}/${hit.command}`, score: hit.score })),
  };
}

function tokenizeDocuments(
  engine: Engine,
  documents: CommandSearchDocument[],
): TokenizedDocument[] {
  return documents.map((document) => {
    const site = document.site.toLowerCase();
    return engine.benchmarkTokenizeDocument(
      [site, ...site.split(/[-_]/)],
      document.site,
      document.command,
      document.description,
      document.category,
    );
  });
}

function lexicalRankers(
  engine: Engine,
  documents: CommandSearchDocument[],
): Ranker[] {
  const started = performance.now();
  const tokens = tokenizeDocuments(engine, documents);
  const postings = new Map<string, Array<{ id: number; frequency: number }>>();
  for (let id = 0; id < tokens.length; id++) {
    for (const [term, frequency] of tokens[id].termFrequencies) {
      const posting = postings.get(term) ?? [];
      posting.push({ id, frequency });
      postings.set(term, posting);
    }
  }
  const idf = new Map(
    [...postings].map(([term, entries]) => [
      term,
      Math.log(
        1 + (documents.length - entries.length + 0.5) / (entries.length + 0.5),
      ),
    ]),
  );
  const avgLength =
    tokens.reduce((sum, document) => sum + document.termCount, 0) /
    tokens.length;
  const lengthNorms = tokens.map(
    (document) => 1.2 * (1 - 0.75 + (0.75 * document.termCount) / avgLength),
  );
  const vectorNorms = tokens.map((document) =>
    Math.sqrt(
      [...document.termFrequencies].reduce(
        (sum, [term, count]) =>
          sum + ((count / document.termCount) * idf.get(term)!) ** 2,
        0,
      ),
    ),
  );
  const build_ms = performance.now() - started;
  return ["bm25", "tfidf"].map((method) => ({
    name: method,
    build_ms,
    search(query: string): Hit[] {
      const terms = engine.benchmarkQueryTerms(query);
      const scores = new Map<number, number>();
      let queryNormSquared = 0;
      for (const term of terms) {
        const termIdf = idf.get(term);
        if (termIdf === undefined) continue;
        queryNormSquared += termIdf ** 2;
        for (const { id, frequency } of postings.get(term)!) {
          const contribution =
            method === "bm25"
              ? (termIdf * (frequency * 2.2)) / (frequency + lengthNorms[id])
              : (termIdf ** 2 * frequency) / tokens[id].termCount;
          scores.set(id, (scores.get(id) ?? 0) + contribution);
        }
      }
      const queryNorm = Math.sqrt(queryNormSquared);
      return [...scores]
        .filter(([id]) => isCommandDiscoverable(documents[id]))
        .map(([id, score]) => ({
          id: `${documents[id].site}/${documents[id].command}`,
          score:
            method === "tfidf" ? score / (queryNorm * vectorNorms[id]) : score,
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 5);
    },
  }));
}

function miniSearchRankers(
  engine: Engine,
  documents: CommandSearchDocument[],
): Ranker[] {
  const start = performance.now();
  const tokens = tokenizeDocuments(engine, documents);
  const index = new MiniSearch<{ id: number; text: string }>({
    fields: ["text"],
    tokenize: (text) => text.split(" "),
    processTerm: (term) => term,
  });
  index.addAll(
    tokens.map((document, id) => ({
      id,
      text: [...document.termFrequencies]
        .flatMap(([term, count]) => Array<string>(count).fill(term))
        .join(" "),
    })),
  );
  const build_ms = performance.now() - start;
  return [false, 0.2].map((fuzzy) => ({
    name: fuzzy ? "minisearch-bm25+-fuzzy" : "minisearch-bm25+",
    build_ms,
    search: (query) =>
      index
        .search(engine.benchmarkQueryTerms(query).join(" "), {
          fuzzy,
          filter: (hit) => isCommandDiscoverable(documents[Number(hit.id)]),
        })
        .slice(0, 5)
        .map((hit) => ({
          id: `${documents[Number(hit.id)].site}/${documents[Number(hit.id)].command}`,
          score: hit.score,
        })),
  }));
}

function quality(ranker: Ranker, cases: Case[]) {
  const ranks = cases.map((entry) => {
    const results = ranker.search(entry.query);
    return {
      ...entry,
      rank: results.findIndex((hit) => entry.accepted.includes(hit.id)) + 1,
      results: results.map((hit) => hit.id),
    };
  });
  const groups = [...new Set(cases.map((entry) => entry.group))];
  return {
    queries: cases.length,
    top1: ranks.filter((entry) => entry.rank === 1).length,
    top3: ranks.filter((entry) => entry.rank > 0 && entry.rank <= 3).length,
    top5: ranks.filter((entry) => entry.rank > 0).length,
    mrr5:
      ranks.reduce(
        (sum, entry) => sum + (entry.rank > 0 ? 1 / entry.rank : 0),
        0,
      ) / cases.length,
    groups: Object.fromEntries(
      groups.map((group) => {
        const members = ranks.filter((entry) => entry.group === group);
        return [
          group,
          {
            queries: members.length,
            top1: members.filter((entry) => entry.rank === 1).length,
            top5: members.filter((entry) => entry.rank > 0).length,
          },
        ];
      }),
    ),
    misses: ranks.filter((entry) => entry.rank !== 1),
  };
}

function coldQuery(directory: string, corpusPath: string, query: string) {
  const worker = join(directory, "cold.mjs");
  writeFileSync(
    worker,
    `import { readFileSync } from "node:fs";
const documents = JSON.parse(readFileSync(process.argv[2], "utf8"));
const started = performance.now();
const engine = await import("./engine.mjs");
const imported = performance.now();
const index = engine.buildIndexFromDocuments(documents);
const built = performance.now();
const result = engine.benchmarkSearchIndex(index, process.argv[3], 5, {});
const complete = performance.now();
console.log(JSON.stringify({ import_ms: imported - started, build_ms: built - imported, first_query_ms: complete - built, ready_ms: complete - started, results: result.length }));
`,
  );
  const started = performance.now();
  const child = spawnSync(process.execPath, [worker, corpusPath, query], {
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  if (child.status !== 0)
    throw new Error(`Cold engine failed\n${child.stderr}`);
  return {
    query,
    wall_ms: performance.now() - started,
    ...JSON.parse(child.stdout),
  } as {
    query: string;
    wall_ms: number;
    import_ms: number;
    build_ms: number;
    first_query_ms: number;
    ready_ms: number;
    results: number;
  };
}

function coldMeasurements(
  directories: string[],
  corpusPath: string,
  queries: string[],
) {
  const samples = directories.map(() => [] as ReturnType<typeof coldQuery>[]);
  for (let run = 0; run < coldRuns; run++) {
    for (let offset = 0; offset < directories.length; offset++) {
      const arm = (offset + run) % directories.length;
      const query = queries[run % queries.length];
      samples[arm].push(coldQuery(directories[arm], corpusPath, query));
    }
  }
  return {
    boundary:
      "fresh Node process importing an ESM engine bundle, building the same corpus, returning one query; excludes CLI parsing and host inventory",
    results: samples.map((runs, arm) => ({
      name: arm === 0 ? "baseline-full" : "candidate-full",
      samples: runs,
      summary:
        runs.length === 0
          ? null
          : Object.fromEntries(
              (
                [
                  "wall_ms",
                  "import_ms",
                  "build_ms",
                  "first_query_ms",
                  "ready_ms",
                ] as const
              ).map((field) => [
                field,
                {
                  median: percentile(
                    runs.map((run) => run[field]),
                    0.5,
                  ),
                  p95: percentile(
                    runs.map((run) => run[field]),
                    0.95,
                  ),
                },
              ]),
            ),
    })),
  };
}

const temporary = mkdtempSync(join(tmpdir(), "unicli-search-baselines-"));
try {
  process.env.UNICLI_DYNAMIC_MACOS = "0";
  process.env.UNICLI_USER_ADAPTER_DIR = join(temporary, "empty-user-adapters");
  const revision = execFileSync(
    "git",
    ["rev-parse", "--verify", `${baselineRef}^{commit}`],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const evalSource = execFileSync(
    "git",
    ["show", `${revision}:tests/unit/search-eval.test.ts`],
    { cwd: root, encoding: "utf8" },
  );
  const frozen = evaluationData(evalSource);
  const independent = JSON.parse(
    readFileSync(join(root, "bench/fixtures/search-intents.json"), "utf8"),
  ) as { cases: Case[]; no_match: string[] };
  loadAllAdapters({ strict: true });
  await loadTsAdapters({ strict: true });
  const documents = runtimeSearchDocuments();
  const catalog = new Set(
    documents.map((document) => `${document.site}/${document.command}`),
  );
  const staleLabels = [...frozen.cases, ...independent.cases]
    .flatMap((entry) => entry.accepted)
    .filter((id) => !catalog.has(id));
  if (staleLabels.length > 0)
    throw new Error(
      `Stale gold labels ${[...new Set(staleLabels)].join(", ")}`,
    );
  const baselineDirectory = mkdtempSync(join(temporary, "baseline-"));
  const candidateDirectory = mkdtempSync(join(temporary, "candidate-"));
  const baseline = await snapshotEngine(baselineDirectory, revision);
  const candidate = await snapshotEngine(candidateDirectory);
  const rankers = [
    fullRanker("baseline-full", baseline, documents),
    fullRanker("candidate-full", candidate, documents),
    ...lexicalRankers(baseline, documents),
    ...miniSearchRankers(baseline, documents),
  ];
  const queries = [
    ...[...frozen.cases, ...independent.cases].map((entry) => entry.query),
    ...frozen.negatives,
    ...independent.no_match,
  ];
  const measurements = new Map(
    rankers.map((ranker) => [ranker.name, [] as number[]]),
  );
  for (const ranker of rankers)
    for (const query of queries) ranker.search(query);
  for (let repeat = 0; repeat < repetitions; repeat++) {
    for (let index = 0; index < queries.length; index++) {
      // Rotate execution order so the candidate never systematically runs last.
      for (let offset = 0; offset < rankers.length; offset++) {
        const ranker = rankers[(index + repeat + offset) % rankers.length];
        const start = performance.now();
        ranker.search(queries[index]);
        measurements.get(ranker.name)!.push(performance.now() - start);
      }
    }
  }
  const corpusPath = join(temporary, "corpus.json");
  writeFileSync(corpusPath, JSON.stringify(documents));
  const coldQueries = [
    ...new Set(independent.cases.map((entry) => entry.group)),
  ].map(
    (group) => independent.cases.find((entry) => entry.group === group)!.query,
  );
  coldQueries.push(
    frozen.cases.find((entry) => entry.group === "zh")!.query,
    independent.no_match[0],
  );
  const miniSearchVersion = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.resolve("minisearch"))),
        "../../package.json",
      ),
      "utf8",
    ),
  ).version as string;
  const output = {
    baseline_revision: revision,
    measured_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      UNICLI_DYNAMIC_MACOS: "0",
      user_adapters: "excluded through UNICLI_USER_ADAPTER_DIR",
      resident_repetitions: repetitions,
      cold_processes_per_engine: coldRuns,
    },
    corpus_documents: documents.length,
    discoverable_documents: documents.filter((document) =>
      isCommandDiscoverable(document),
    ).length,
    dynamic_inventory: "disabled identically for all rankers",
    methodology: {
      corpus:
        "One current built-in adapter and core-command corpus shared by every method; host inventory and user overlays excluded",
      lexical_analysis:
        "Frozen NFKC bilingual tokenizer and alias expansion; same document tokens and frequency counts",
      full_engine:
        "Complete src snapshot bundled at the named revision; private scorer exported only in temporary benchmark copies",
      bm25: "k1=1.2 b=0.75; token-count document length; BM25 IDF",
      tfidf:
        "Cosine similarity using normalized term frequency and the same BM25 IDF as the frozen hybrid",
      minisearch: `Installed locked MiniSearch ${miniSearchVersion}; default BM25+ k=1.2 b=0.7 delta=0.5, matched-query-term multiplier, unique-term field length, OR matching; exact and official README fuzzy=0.2 presets; prefix disabled`,
      minisearch_source:
        "https://github.com/lucaong/minisearch/blob/3d239d1c3ae7aef1bf5d8945dd7b5f0709f646f5/src/MiniSearch.ts",
      build_boundary:
        "Same command-document objects through tokenization and index construction; each lexical pair shares an index; one in-process sample per method; repeated fresh-process builds below",
      resident_boundary:
        "Query analysis, retrieval, scoring, top-5 selection, result shaping; full engines include routing and capability decoration",
      quality:
        "617 frozen regression queries and independent task-contract queries reported separately; no parameter fitting",
      negative_scores:
        "Raw scores have algorithm-specific scales; the legacy score<10 rule applies only to full-engine regression",
    },
    results: rankers.map((ranker) => ({
      name: ranker.name,
      build_ms: ranker.build_ms,
      resident: {
        queries: measurements.get(ranker.name)!.length,
        median_ms: percentile(measurements.get(ranker.name)!, 0.5),
        p95_ms: percentile(measurements.get(ranker.name)!, 0.95),
      },
      regression: quality(ranker, frozen.cases),
      independent: quality(ranker, independent.cases),
      negatives: frozen.negatives.map((query) => {
        const results = ranker.search(query);
        return { query, count: results.length, first: results[0] ?? null };
      }),
      no_match: independent.no_match.map((query) => ({
        query,
        results: ranker.search(query),
      })),
    })),
    candidate_changes: queries.flatMap((query) => {
      const before = rankers[0].search(query);
      const after = rankers[1].search(query);
      return JSON.stringify(before) === JSON.stringify(after)
        ? []
        : [{ query, baseline: before, candidate: after }];
    }),
    cold: coldMeasurements(
      [baselineDirectory, candidateDirectory],
      corpusPath,
      coldQueries,
    ),
  };
  const json = JSON.stringify(output, null, 2);
  writeFileSync(join(root, "bench/search-baselines.results.json"), `${json}\n`);
  console.log(json);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
