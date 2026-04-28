/**
 * BM25-based bilingual search engine for command discovery.
 *
 * Replaces the naive `String.includes()` filter with a proper information
 * retrieval algorithm. Designed for ~1000 commands across ~200 sites.
 *
 * Architecture:
 *   1. Build-time: `scripts/build-manifest.js` generates the inverted index
 *      and IDF values, shipped as `dist/manifest-search.json`.
 *   2. Runtime: this module loads the index lazily on first search call,
 *      then scores queries using BM25 with bilingual keyword expansion.
 *
 * Performance: <10ms for 1000 documents on a cold index load. The inverted
 * index is ~50KB — small enough to hold in memory permanently.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandToken,
  tokenizeQuery,
  SITE_ALIASES,
  SITE_CATEGORIES,
  CATEGORY_ALIASES,
} from "./aliases.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  site: string;
  command: string;
  description: string;
  score: number;
  usage: string;
  category: string;
}

/** One document in the search corpus: a single adapter command. */
interface Document {
  id: string; // "site/command"
  site: string;
  command: string;
  description: string;
  /** Pre-tokenized terms from site + command + description */
  terms: string[];
  /** Total term count for BM25 length normalization */
  termCount: number;
}

interface CoreSearchDocument {
  site: string;
  command: string;
  description: string;
}

/** Serialized search index (generated at build time, loaded at runtime). */
export interface SearchIndex {
  /** Mapping: term → list of document indices that contain this term */
  postings: Record<string, number[]>;
  /** IDF (Inverse Document Frequency) for each term */
  idf: Record<string, number>;
  /** All documents with their metadata */
  documents: Array<{
    id: string;
    site: string;
    command: string;
    description: string;
    terms: string[];
  }>;
  /** Average document length (term count) across the corpus */
  avgDl: number;
  /** Total document count */
  N: number;
}

// ── BM25 Parameters ─────────────────────────────────────────────────────────
// Standard BM25 tuning. k1 controls term frequency saturation,
// b controls document length normalization.

const K1 = 1.2;
const B = 0.75;

// ── Hybrid Scoring ──────────────────────────────────────────────────────────
// StackOne benchmark (Feb 2026, 2700 test cases, 270 tools) found:
//   Pure BM25 Top-1: 14%
//   BM25+TF-IDF 20/80 blend Top-1: 21%
//   Embedding Top-1: 38%
// We use the 20/80 blend as the base, with domain-specific boosts on top.

const ALPHA_BM25 = 0.2;
const ALPHA_TFIDF = 0.8;

// ── Score Boost Weights ─────────────────────────────────────────────────────
// Applied on top of the hybrid BM25+TF-IDF base score.

const BOOST_SITE_EXACT = 15.0; // Query token exactly matches site name
const BOOST_SITE_ALIAS = 12.0; // Query token's alias matches site name
const BOOST_CMD_EXACT = 8.0; // Query token exactly matches command name
const BOOST_CMD_PARTIAL = 3.0; // Query token is substring of command name
const BOOST_CATEGORY = 2.0; // Query token matches site's category
const BOOST_RUN_TRACE_INTENT = 45.0; // Recorded trace/replay/audit queries

const CORE_SEARCH_DOCUMENTS: readonly CoreSearchDocument[] = [
  {
    site: "browser",
    command: "evidence",
    description:
      "Capture browser operator evidence for web automation, website control, agent workflows, MCP/CLI debugging, DOM snapshots, screenshots, network summaries, render-aware observation, session leases, and audit trails.",
  },
  {
    site: "browser",
    command: "extract",
    description:
      "Extract rendered website text through the browser operator with render-aware waiting, session lease metadata, DOM evidence, and agent-friendly structured output.",
  },
  {
    site: "browser",
    command: "state",
    description:
      "Read the current browser page state, accessibility tree, refs, URL, and DOM snapshot for website control and agent browser automation.",
  },
  {
    site: "browser",
    command: "click",
    description:
      "Click a browser page ref with stale-ref checks, session lease ownership, action evidence, watchdog movement checks, and recorded run traces.",
  },
  {
    site: "browser",
    command: "bind",
    description:
      "Bind the current visible browser tab into a named workspace with domain and path guards for profile reuse and multi-command automation.",
  },
  {
    site: "operate",
    command: "state",
    description:
      "Inspect the current browser automation workspace for agent operation, website control, page refs, and accessibility tree state.",
  },
  {
    site: "operate",
    command: "click",
    description:
      "Operate a browser page by clicking refs with recorded evidence and session lease metadata.",
  },
  {
    site: "mcp",
    command: "serve",
    description:
      "Serve Uni-CLI through MCP for agents, exposing command search, command run, browser/web capabilities, structured envelopes, and protocol integration.",
  },
  {
    site: "agents",
    command: "recommend",
    description:
      "Recommend the right agent backend or CLI for a task, including Codex, Claude Code, OpenCode, MCP, ACP, browser, desktop, and tool workflows.",
  },
  {
    site: "runs",
    command: "list",
    description:
      "List recorded Uni-CLI run traces, browser session leases, evidence events, watchdog outcomes, command status, and replay/index metadata.",
  },
  {
    site: "runs",
    command: "show",
    description:
      "Show recorded run trace events for debugging, replay preparation, browser lease evidence, render stability, and agent audit review.",
  },
];

// ── Index Management ────────────────────────────────────────────────────────

let cachedIndex: SearchIndex | null = null;

/**
 * Resolve the path to the pre-built search index.
 * Falls back to building one on-the-fly from the manifest if the
 * pre-built index doesn't exist.
 */
function getIndexPath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, "..", "..", "dist", "manifest-search.json");
}

/**
 * Load or build the search index. Called lazily on first search.
 */
function loadIndex(): SearchIndex {
  if (cachedIndex) return cachedIndex;

  const indexPath = getIndexPath();
  if (existsSync(indexPath)) {
    cachedIndex = augmentIndexWithCoreDocs(
      JSON.parse(readFileSync(indexPath, "utf-8")) as SearchIndex,
    );
    return cachedIndex;
  }

  // Fallback: build index on-the-fly from manifest.json
  cachedIndex = augmentIndexWithCoreDocs(buildIndexFromManifest());
  return cachedIndex;
}

function augmentIndexWithCoreDocs(index: SearchIndex): SearchIndex {
  const manifest: {
    sites: Record<
      string,
      { commands: Array<{ name: string; description: string }> }
    >;
  } = { sites: {} };
  const seen = new Set<string>();

  for (const doc of index.documents) {
    manifest.sites[doc.site] ??= { commands: [] };
    manifest.sites[doc.site].commands.push({
      name: doc.command,
      description: doc.description,
    });
    seen.add(doc.id);
  }

  for (const doc of CORE_SEARCH_DOCUMENTS) {
    const id = `${doc.site}/${doc.command}`;
    if (seen.has(id)) continue;
    manifest.sites[doc.site] ??= { commands: [] };
    manifest.sites[doc.site].commands.push({
      name: doc.command,
      description: doc.description,
    });
  }

  return buildIndex(manifest);
}

/**
 * Build a search index from the manifest.json file.
 * Used when the pre-built search index doesn't exist (dev mode).
 */
function buildIndexFromManifest(): SearchIndex {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(__dirname, "..", "..", "dist", "manifest.json");

  if (!existsSync(manifestPath)) {
    // No manifest either — search will silently return zero results.
    // Emit an actionable hint to stderr so CI/dev failures point to the fix.
    process.stderr.write(
      "[unicli search] Missing dist/manifest-search.json and dist/manifest.json. " +
        "Run: npm run build:manifest\n",
    );
    return { postings: {}, idf: {}, documents: [], avgDl: 0, N: 0 };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    sites: Record<
      string,
      { commands: Array<{ name: string; description: string }> }
    >;
  };

  return buildIndex(manifest);
}

/**
 * Build a search index from a manifest object.
 * Exported for use by the build script.
 */
export function buildIndex(manifest: {
  sites: Record<
    string,
    { commands: Array<{ name: string; description: string }> }
  >;
}): SearchIndex {
  const documents: Document[] = [];

  for (const [site, info] of Object.entries(manifest.sites)) {
    for (const cmd of info.commands) {
      const terms = tokenizeDocument(site, cmd.name, cmd.description ?? "");
      documents.push({
        id: `${site}/${cmd.name}`,
        site,
        command: cmd.name,
        description: cmd.description ?? "",
        terms,
        termCount: terms.length,
      });
    }
  }

  const N = documents.length;
  const avgDl =
    N > 0 ? documents.reduce((sum, d) => sum + d.termCount, 0) / N : 0;

  // Build inverted index
  const postings: Record<string, number[]> = {};
  for (let i = 0; i < documents.length; i++) {
    const seen = new Set<string>();
    for (const term of documents[i].terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      if (!postings[term]) postings[term] = [];
      postings[term].push(i);
    }
  }

  // Compute IDF for each term
  const idf: Record<string, number> = {};
  for (const [term, docs] of Object.entries(postings)) {
    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const df = docs.length;
    idf[term] = Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  return {
    postings,
    idf,
    documents: documents.map((d) => ({
      id: d.id,
      site: d.site,
      command: d.command,
      description: d.description,
      terms: d.terms,
    })),
    avgDl,
    N,
  };
}

// Minimal English stopwords — same set used in query tokenization
const DOC_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "and",
  "or",
  "in",
  "to",
  "on",
  "by",
  "is",
  "it",
  "be",
  "as",
  "at",
  "so",
  "we",
  "he",
  "do",
  "no",
  "if",
  "up",
  "my",
]);

// Regex to keep alphanumeric, CJK (all planes), and whitespace.
// Uses the `u` flag for supplementary plane support.
const DOC_CLEAN_REGEX =
  /[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u{31350}-\u{323af}\s]/gu;

/**
 * Tokenize a document (site + command + description) into search terms.
 * Produces lowercase terms, splits on hyphens and underscores.
 * Applies NFKC normalization and stopword filtering for alignment with
 * the query tokenizer.
 */
function tokenizeDocument(
  site: string,
  command: string,
  description: string,
): string[] {
  const terms: string[] = [];

  // Site name and its parts
  const siteParts = site.toLowerCase().split(/[-_]/);
  terms.push(site.toLowerCase(), ...siteParts);

  // Command name and its parts
  const cmdParts = command.toLowerCase().split(/[-_]/);
  terms.push(command.toLowerCase(), ...cmdParts);

  // NFKC normalize description (full-width → half-width, etc.)
  const normalizedDesc = description.normalize("NFKC");

  // Description words (lowercase, filter short words and stopwords)
  const descWords = normalizedDesc
    .toLowerCase()
    .replace(DOC_CLEAN_REGEX, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !DOC_STOPWORDS.has(w));
  terms.push(...descWords);

  // Category as a term
  const category = SITE_CATEGORIES.get(site);
  if (category) terms.push(category);

  return terms;
}

// ── BM25 Scoring ────────────────────────────────────────────────────────────

/**
 * Compute BM25 score for a single document given query terms.
 */
function bm25Score(
  docTerms: string[],
  docLength: number,
  queryTerms: string[],
  index: SearchIndex,
): number {
  let score = 0;

  // Count term frequencies in this document
  const tf = new Map<string, number>();
  for (const term of docTerms) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }

  for (const qt of queryTerms) {
    const termIdf = index.idf[qt];
    if (termIdf === undefined) continue; // term not in corpus

    const termTf = tf.get(qt) ?? 0;
    if (termTf === 0) continue;

    // BM25 TF component: (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl/avgdl))
    const numerator = termTf * (K1 + 1);
    const denominator = termTf + K1 * (1 - B + B * (docLength / index.avgDl));
    score += termIdf * (numerator / denominator);
  }

  return score;
}

// ── TF-IDF Cosine Similarity ────────────────────────────────────────────────

/**
 * Compute TF-IDF cosine similarity between a query and a document.
 *
 * TF-IDF for a term t in document d:
 *   tf(t,d) = count(t in d) / |d|
 *   tfidf(t,d) = tf(t,d) * idf(t)
 *
 * Cosine similarity = dot(query_vec, doc_vec) / (|query_vec| * |doc_vec|)
 */
function tfidfCosine(
  docTerms: string[],
  queryTerms: string[],
  index: SearchIndex,
): number {
  const docLen = docTerms.length;
  if (docLen === 0) return 0;

  // Build full doc TF map
  const docTf = new Map<string, number>();
  for (const term of docTerms) {
    docTf.set(term, (docTf.get(term) ?? 0) + 1);
  }

  // Compute full document norm (all terms, not just query overlap)
  let docNormSq = 0;
  for (const [term, count] of docTf) {
    const idfVal = index.idf[term];
    if (idfVal === undefined) continue;
    const w = (count / docLen) * idfVal;
    docNormSq += w * w;
  }

  // Compute query norm and dot product
  let dotProduct = 0;
  let queryNormSq = 0;

  for (const qt of queryTerms) {
    const idfVal = index.idf[qt];
    if (idfVal === undefined) continue;

    // Query TF-IDF: binary tf (1) × idf
    const queryWeight = idfVal;
    queryNormSq += queryWeight * queryWeight;

    // Doc TF-IDF: normalized tf × idf
    const rawTf = docTf.get(qt) ?? 0;
    if (rawTf === 0) continue;
    const docWeight = (rawTf / docLen) * idfVal;
    dotProduct += queryWeight * docWeight;
  }

  const normProduct = Math.sqrt(queryNormSq) * Math.sqrt(docNormSq);
  if (normProduct === 0) return 0;

  return dotProduct / normProduct;
}

// ── Main Search Function ────────────────────────────────────────────────────

/**
 * Search all commands by natural language query.
 *
 * Algorithm:
 *   1. Tokenize query (bilingual-aware)
 *   2. Expand tokens via alias table
 *   3. Compute BM25 base score for each candidate document
 *   4. Apply boost signals (site match, command match, category match)
 *   5. Return top-K results with usage examples
 *
 * @param query - Natural language query (Chinese or English)
 * @param limit - Maximum results to return (default 5)
 */
export function search(query: string, limit = 5): SearchResult[] {
  const index = loadIndex();
  if (index.N === 0) return [];

  // Step 1: Tokenize
  const rawTokens = tokenizeQuery(query);

  // Step 2: Expand via aliases
  const expandedTerms: string[] = [];
  const siteHints: string[] = []; // Directly matched site names
  const categoryHints: string[] = []; // Matched categories

  for (const token of rawTokens) {
    const expanded = expandToken(token);
    expandedTerms.push(...expanded);

    // Check if this token resolves to a site name
    const siteMatch =
      SITE_ALIASES.get(token) ?? SITE_ALIASES.get(token.toLowerCase());
    if (siteMatch) siteHints.push(siteMatch);

    // Check if this token is directly a known site
    if (index.documents.some((d) => d.site === token.toLowerCase())) {
      siteHints.push(token.toLowerCase());
    }

    // Check category alias
    const catMatch =
      CATEGORY_ALIASES.get(token) ?? CATEGORY_ALIASES.get(token.toLowerCase());
    if (catMatch) categoryHints.push(catMatch);
  }

  const queryTerms = [...new Set(expandedTerms.map((t) => t.toLowerCase()))];

  // Step 3: Find candidate documents (union of posting lists)
  const candidateSet = new Set<number>();
  for (const qt of queryTerms) {
    const postings = index.postings[qt];
    if (postings) {
      for (const docIdx of postings) {
        candidateSet.add(docIdx);
      }
    }
  }

  // If site hints exist, also add ALL commands for those sites
  if (siteHints.length > 0) {
    for (let i = 0; i < index.documents.length; i++) {
      if (siteHints.includes(index.documents[i].site)) {
        candidateSet.add(i);
      }
    }
  }

  if (candidateSet.size === 0) return [];

  // Step 4: Score candidates using hybrid BM25 + TF-IDF
  const scored: Array<{ idx: number; score: number }> = [];

  for (const idx of candidateSet) {
    const doc = index.documents[idx];

    // Hybrid base: alpha-blend BM25 and TF-IDF cosine similarity.
    // BM25 scores are unbounded; cosine is [0,1]. We scale cosine by the
    // average BM25 score across candidates to keep the blend balanced.
    const bm25 = bm25Score(doc.terms, doc.terms.length, queryTerms, index);
    const tfidf = tfidfCosine(doc.terms, queryTerms, index);
    let score = ALPHA_BM25 * bm25 + ALPHA_TFIDF * tfidf * 10;

    // Boost: exact site name match
    if (siteHints.includes(doc.site)) {
      score += BOOST_SITE_EXACT;
    }

    // Boost: alias-resolved site match
    for (const qt of queryTerms) {
      if (qt === doc.site) score += BOOST_SITE_ALIAS;
      if (qt === doc.command) score += BOOST_CMD_EXACT;
      if (doc.command.includes(qt) && qt.length > 2) score += BOOST_CMD_PARTIAL;
    }

    // Boost: category match
    const docCategory = SITE_CATEGORIES.get(doc.site);
    if (docCategory && categoryHints.includes(docCategory)) {
      score += BOOST_CATEGORY;
    }

    score += architectureIntentBoost(doc, queryTerms);

    if (score > 0) scored.push({ idx, score });
  }

  // Step 5: Sort and return top-K
  scored.sort((a, b) => b.score - a.score);
  const topK = scored.slice(0, limit);

  return topK.map(({ idx, score }) => {
    const doc = index.documents[idx];
    const category = SITE_CATEGORIES.get(doc.site) ?? "other";
    return {
      site: doc.site,
      command: doc.command,
      description: doc.description,
      score: Math.round(score * 100) / 100,
      usage: buildUsageExample(doc.site, doc.command),
      category,
    };
  });
}

/**
 * Build a usage example string for a command.
 */
function buildUsageExample(site: string, command: string): string {
  return `unicli ${site} ${command}`;
}

function architectureIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  const terms = new Set(queryTerms);
  const runTraceIntent =
    (hasAny(terms, ["run", "runs"]) &&
      hasAny(terms, ["trace", "traces", "recorded", "record", "replay"])) ||
    (terms.has("trace") && hasAny(terms, ["evidence", "audit", "lease"]));
  if (runTraceIntent && doc.site === "runs") {
    return BOOST_RUN_TRACE_INTENT;
  }
  return 0;
}

function hasAny(terms: Set<string>, values: string[]): boolean {
  return values.some((value) => terms.has(value));
}

/**
 * Force-reload the search index (useful after index rebuild).
 */
export function invalidateCache(): void {
  cachedIndex = null;
}
