/**
 * @owner   src/discovery/search.ts
 * @does    Score command-intent queries against live registry or manifest command documents.
 * @needs   ./aliases, ./intents, ./core-catalog, ./macos-dynamic, ../registry
 * @feeds   src/commands/search.ts, src/mcp/handler.ts, src/fast-path/handlers/discovery.ts
 * @breaks  Returns an empty result set when the registry/manifest has no matching commands.
 * @invariants Runtime search uses the live registry; generated search-index artifacts are not a source of truth.
 * @side-effects Caches an in-memory index by command-document signature; reads dynamic macOS data only when enabled.
 * @perf    Cold index build is O(commands * terms); warm searches reuse the cache until documents change.
 * @concurrency Module cache is process-local and rebuilt synchronously inside a search call.
 * @test    tests/unit/search.test.ts, tests/unit/search-eval.test.ts, tests/unit/commands/search.test.ts
 * @stability Public CLI/MCP discovery behavior.
 * @since   0.223.4
 */

import {
  expandToken,
  tokenizeQuery,
  SITE_ALIASES,
  SITE_CATEGORIES,
  CATEGORY_ALIASES,
} from "./aliases.js";
import { intentBoost } from "./intents.js";
import {
  buildMacosDynamicSearchDocuments,
  discoverMacosDynamicData,
  dynamicMacosDiscoveryEnabled,
} from "./macos-dynamic.js";
import {
  coreDiscoveryCategory,
  listCoreDiscoveryCommands,
} from "./core-catalog.js";
import { getRegistryVersion, listCommands } from "../registry.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  site: string;
  command: string;
  description: string;
  score: number;
  usage: string;
  category: string;
}

export interface SearchOptions {
  category?: string;
}

export interface CommandSearchDocument {
  site: string;
  command: string;
  description: string;
  category?: string;
}

/** One document in the search corpus: a single adapter command. */
interface Document {
  id: string; // "site/command"
  site: string;
  command: string;
  description: string;
  category?: string;
  /** Pre-tokenized terms from site + command + description */
  terms: string[];
  /** Total term count for BM25 length normalization */
  termCount: number;
}

/** In-memory search index built from command documents. */
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
    category?: string;
    terms: string[];
  }>;
  /** Average document length (term count) across the corpus */
  avgDl: number;
  /** Total document count */
  N: number;
  /** Registered site names for O(1) query hint checks. */
  siteLookup: Record<string, true>;
  /** Normalized multi-token site names for phrase hint matching. */
  sitePhrases: Array<{ site: string; phrase: string }>;
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
const BOOST_SITE_PHRASE = 28.0; // Query phrase matches hyphenated site name
const BOOST_CMD_EXACT = 8.0; // Query token exactly matches command name
const BOOST_CMD_PARTIAL = 3.0; // Query token is substring of command name
const BOOST_CATEGORY = 2.0; // Query token matches site's category

// ── Index Management ────────────────────────────────────────────────────────

let cachedIndex: SearchIndex | null = null;
let cachedRegistryVersion = -1;

/**
 * Load the live registry search index. Called lazily on first search.
 */
function loadIndex(): SearchIndex {
  const registryVersion = getRegistryVersion();
  if (cachedIndex && cachedRegistryVersion === registryVersion) {
    return cachedIndex;
  }
  const documents = runtimeSearchDocuments();
  cachedIndex = buildIndexFromDocuments(documents);
  cachedRegistryVersion = registryVersion;
  return cachedIndex;
}

function runtimeSearchDocuments(): CommandSearchDocument[] {
  const seen = new Set<string>();
  const documents: CommandSearchDocument[] = [];

  for (const command of listCommands()) {
    const id = `${command.site}/${command.command}`;
    seen.add(id);
    documents.push({
      site: command.site,
      command: command.command,
      description: command.description,
      category: command.category,
    });
  }

  for (const doc of listCoreDiscoveryCommands()) {
    const id = `${doc.site}/${doc.command}`;
    if (seen.has(id)) continue;
    seen.add(id);
    documents.push({
      site: doc.site,
      command: doc.command,
      description: doc.description,
      category: doc.category,
    });
  }

  return documents;
}

export function buildIndexFromDocuments(
  searchDocuments: readonly CommandSearchDocument[],
): SearchIndex {
  const documents: Document[] = [];
  const siteSet = new Set<string>();

  for (const doc of searchDocuments) {
    siteSet.add(doc.site);
    const terms = tokenizeDocument(
      doc.site,
      doc.command,
      doc.description,
      doc.category,
    );
    documents.push({
      id: `${doc.site}/${doc.command}`,
      site: doc.site,
      command: doc.command,
      description: doc.description,
      ...(doc.category ? { category: doc.category } : {}),
      terms,
      termCount: terms.length,
    });
  }

  const siteLookup = Object.fromEntries(
    Array.from(siteSet, (site) => [site, true] as const),
  );
  const sitePhrases = Array.from(siteSet, (site) => ({
    site,
    phrase: normalizeSitePhrase(site),
  })).filter((entry) => entry.phrase.includes(" "));

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
      ...(d.category ? { category: d.category } : {}),
      terms: d.terms,
    })),
    avgDl,
    N,
    siteLookup,
    sitePhrases,
  };
}

export function searchDocuments(
  documents: readonly CommandSearchDocument[],
  query: string,
  limit = 5,
  options: SearchOptions = {},
): SearchResult[] {
  const staticResults = searchIndex(
    buildIndexFromDocuments(documents),
    query,
    limit,
    options,
  );
  const dynamicResults = searchDynamicMacosIndex(query, limit, options);

  return mergeSearchResults(staticResults, dynamicResults, limit);
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

// Regex to keep alphanumeric, CJK (all planes), Japanese kana, and whitespace.
// Uses the `u` flag for supplementary plane support.
const DOC_CLEAN_REGEX =
  /[^a-z0-9\u3040-\u30ff\u31f0-\u31ff\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u{31350}-\u{323af}\s]/gu;

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
  category?: string,
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
  const categoryTerm = category ?? SITE_CATEGORIES.get(site);
  if (categoryTerm) terms.push(categoryTerm);

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
export function search(
  query: string,
  limit = 5,
  options: SearchOptions = {},
): SearchResult[] {
  const staticResults = searchIndex(loadIndex(), query, limit, options);
  const dynamicResults = searchDynamicMacosIndex(query, limit, options);

  return mergeSearchResults(staticResults, dynamicResults, limit);
}

function mergeSearchResults(
  staticResults: SearchResult[],
  dynamicResults: SearchResult[],
  limit: number,
): SearchResult[] {
  if (dynamicResults.length === 0) return staticResults;

  const byCommand = new Map<string, SearchResult>();
  for (const result of [...staticResults, ...dynamicResults]) {
    const key = `${result.site}/${result.command}`;
    const existing = byCommand.get(key);
    if (!existing || result.score > existing.score) {
      byCommand.set(key, result);
    }
  }

  return Array.from(byCommand.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function searchDynamicMacosIndex(
  query: string,
  limit: number,
  options: SearchOptions,
): SearchResult[] {
  if (!dynamicMacosDiscoveryEnabled()) return [];
  if (options.category && options.category !== "desktop") return [];

  const docs = buildMacosDynamicSearchDocuments(discoverMacosDynamicData());
  if (docs.length === 0) return [];

  return searchIndex(
    buildIndexFromDocuments(
      docs.map((doc) => ({
        site: doc.site,
        command: doc.command,
        description: doc.description,
        category: "desktop",
      })),
    ),
    query,
    limit,
    options,
  );
}

function searchIndex(
  index: SearchIndex,
  query: string,
  limit: number,
  options: SearchOptions,
): SearchResult[] {
  if (index.N === 0) return [];

  // Step 1: Tokenize
  const rawTokens = tokenizeQuery(query);

  // Step 2: Expand via aliases
  const expandedTerms: string[] = [];
  const siteHints: string[] = []; // Directly matched site names
  const sitePhraseHints = deriveSitePhraseHints(index, query);
  const categoryHints: string[] = []; // Matched categories

  for (const token of rawTokens) {
    const expanded = expandToken(token);
    expandedTerms.push(...expanded);

    // Check if this token resolves to a site name
    const siteMatch =
      SITE_ALIASES.get(token) ?? SITE_ALIASES.get(token.toLowerCase());
    if (siteMatch) siteHints.push(siteMatch);

    // Check if this token is directly a known site
    const lowerToken = token.toLowerCase();
    if (index.siteLookup[lowerToken]) {
      siteHints.push(lowerToken);
    }

    // Check category alias
    const catMatch =
      CATEGORY_ALIASES.get(token) ?? CATEGORY_ALIASES.get(token.toLowerCase());
    if (catMatch) categoryHints.push(catMatch);
  }

  const queryTerms = [...new Set(expandedTerms.map((t) => t.toLowerCase()))];
  const categoryFilter = options.category;

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
  for (const siteHint of new Set([...siteHints, ...sitePhraseHints])) {
    addSiteCandidates(index, siteHint, candidateSet);
  }
  if (queryTerms.length === 0 && categoryFilter) {
    addCategoryCandidates(index, categoryFilter, candidateSet);
  }

  if (candidateSet.size === 0) return [];

  // Step 4: Score candidates using hybrid BM25 + TF-IDF
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const shouldSortAll = boundedLimit >= candidateSet.size;
  const scored: Array<{ idx: number; score: number }> = [];
  const topScored: Array<{ idx: number; score: number }> = [];

  for (const idx of candidateSet) {
    const doc = index.documents[idx];
    const docCategory = documentCategory(doc);
    if (categoryFilter && docCategory !== categoryFilter) continue;

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
    if (sitePhraseHints.includes(doc.site)) {
      score += BOOST_SITE_PHRASE;
    }

    // Boost: alias-resolved site match
    for (const qt of queryTerms) {
      if (qt === doc.site) score += BOOST_SITE_ALIAS;
      if (qt === doc.command) score += BOOST_CMD_EXACT;
      if (doc.command.includes(qt) && qt.length > 2) score += BOOST_CMD_PARTIAL;
    }

    // Boost: category match
    if (categoryHints.includes(docCategory)) {
      score += BOOST_CATEGORY;
    }

    score += intentBoost(doc, queryTerms, [...siteHints, ...sitePhraseHints]);
    if (categoryFilter && queryTerms.length === 0) score += BOOST_CATEGORY;

    if (score <= 0) continue;
    if (shouldSortAll) {
      scored.push({ idx, score });
    } else {
      pushTopScore(topScored, { idx, score }, boundedLimit);
    }
  }

  // Step 5: Sort and return top-K
  const topK = shouldSortAll
    ? scored.sort((a, b) => b.score - a.score).slice(0, boundedLimit)
    : topScored;

  return topK.map(({ idx, score }) => {
    const doc = index.documents[idx];
    return {
      site: doc.site,
      command: doc.command,
      description: doc.description,
      score: Math.round(score * 100) / 100,
      usage: buildUsageExample(doc.site, doc.command),
      category: documentCategory(doc),
    };
  });
}

function addSiteCandidates(
  index: SearchIndex,
  site: string,
  candidateSet: Set<number>,
): void {
  for (const docIdx of index.postings[site] ?? []) {
    if (index.documents[docIdx]?.site === site) candidateSet.add(docIdx);
  }
}

function addCategoryCandidates(
  index: SearchIndex,
  category: string,
  candidateSet: Set<number>,
): void {
  for (const docIdx of index.postings[category] ?? []) {
    const doc = index.documents[docIdx];
    if (doc && documentCategory(doc) === category) candidateSet.add(docIdx);
  }
}

function pushTopScore(
  topScored: Array<{ idx: number; score: number }>,
  candidate: { idx: number; score: number },
  limit: number,
): void {
  let insertAt = topScored.findIndex((entry) => candidate.score > entry.score);
  if (insertAt === -1) insertAt = topScored.length;
  if (insertAt >= limit) return;
  topScored.splice(insertAt, 0, candidate);
  if (topScored.length > limit) topScored.pop();
}

function documentCategory(doc: SearchIndex["documents"][number]): string {
  return (
    doc.category ??
    coreDiscoveryCategory(doc.site) ??
    SITE_CATEGORIES.get(doc.site) ??
    "other"
  );
}

function deriveSitePhraseHints(index: SearchIndex, query: string): string[] {
  const normalizedQuery = normalizeSitePhrase(query);
  if (normalizedQuery.length === 0) return [];

  const hints: string[] = [];
  for (const { site, phrase } of index.sitePhrases) {
    if (hasPhrase(normalizedQuery, phrase)) {
      hints.push(site);
    }
  }
  return hints;
}

function normalizeSitePhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

/**
 * Build a usage example string for a command.
 */
function buildUsageExample(site: string, command: string): string {
  return `unicli ${site} ${command}`;
}

/**
 * Force-reload the search index (useful after index rebuild).
 */
export function invalidateCache(): void {
  cachedIndex = null;
  cachedRegistryVersion = -1;
}
