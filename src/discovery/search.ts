/**
 * @owner   src/discovery/search.ts
 * @does    Score command-intent queries against live registry or manifest command documents.
 * @needs   ./aliases, ./intents, ./core-catalog, ./macos-dynamic, ../registry
 * @feeds   src/commands/search.ts, src/mcp/handler.ts, src/fast-path/handlers/discovery.ts
 * @breaks  Returns an empty result set when the registry/manifest has no matching commands.
 * @invariants Runtime search uses the live registry; generated search-index artifacts are not a source of truth.
 * @side-effects Caches an in-memory index by command-document signature; reads dynamic macOS data only when enabled.
 * @perf    Cold index build is O(commands * terms); warm retrieval is O(postings + feasible candidates * log(limit)) through a bounded min-heap.
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
import {
  appActionScorePrior,
  evaluateIntentFrame,
  intentBoost,
  resolveIntentFrame,
} from "./intents.js";
import {
  buildMacosDynamicSearchDocuments,
  discoverMacosDynamicData,
  dynamicMacosDiscoveryEnabled,
  invalidateMacosDynamicCache,
} from "./macos-dynamic.js";
import {
  coreDiscoveryCategory,
  listCoreDiscoveryCommands,
} from "./core-catalog.js";
import { getRegistryVersion, listCommands } from "../registry.js";
import {
  commandFeasibilityProfile,
  evaluateCommandFeasibility,
  evaluateFeasibilityProfile,
  type CapabilityRequirements,
  type CommandFeasibilityProfile,
} from "./feasibility.js";
import { buildCoreCommandContract } from "../core/command-contract.js";
import { BoundedTopK } from "../core/bounded-top-k.js";
import {
  intentEntityCommandBoost,
  resolveTaskIntentFrame,
} from "../core/intent-frame.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  site: string;
  command: string;
  description: string;
  score: number;
  usage: string;
  category: string;
  feasibility?: CommandFeasibilityProfile;
}

export interface SearchOptions {
  category?: string;
  requirements?: CapabilityRequirements;
}

export interface CommandSearchDocument {
  site: string;
  command: string;
  description: string;
  category?: string;
  feasibility?: CommandFeasibilityProfile;
}

/** One document in the search corpus: a single adapter command. */
interface Document {
  id: string; // "site/command"
  site: string;
  command: string;
  description: string;
  category?: string;
  feasibility?: CommandFeasibilityProfile;
  /** Pre-tokenized terms from site + command + description */
  terms: string[];
  /** Total term count for BM25 length normalization */
  termCount: number;
}

interface ScoredCandidate {
  idx: number;
  score: number;
  ordinal: number;
  feasibility?: CommandFeasibilityProfile;
}

/** In-memory search index built from command documents. */
export interface SearchIndex {
  /** Mapping: term → list of document indices that contain this term */
  postings: Map<string, number[]>;
  /** Term frequencies aligned by position with each postings list. */
  frequencies: Map<string, number[]>;
  /** IDF (Inverse Document Frequency) for each term */
  idf: Map<string, number>;
  /** All documents with their metadata */
  documents: Array<{
    id: string;
    site: string;
    command: string;
    description: string;
    category?: string;
    feasibility?: CommandFeasibilityProfile;
    terms: string[];
    /** Query-independent BM25 denominator component. */
    bm25LengthNorm: number;
    /** Query-independent TF-IDF document-vector norm. */
    tfidfNorm: number;
    /** Normalized fields used by exact phrase boosts. */
    normalizedCommand: string;
    normalizedDescription: string;
  }>;
  /** Average document length (term count) across the corpus */
  avgDl: number;
  /** Total document count */
  N: number;
  /** Registered site names for O(1) query hint checks. */
  siteLookup: Set<string>;
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
const BOOST_CMD_EXACT = 8.0; // Entire query exactly matches command name
const BOOST_CMD_TOKEN = 2.0; // One token in a longer intent names the action
const BOOST_CMD_PARTIAL = 3.0; // Query token is substring of command name
const BOOST_DESCRIPTION_PHRASE = 18.0; // Multi-token phrase appears in description
const BOOST_CATEGORY = 2.0; // Query token matches site's category
const PROVIDER_DIVERSITY_ACTION_TERMS = new Set([
  "tag",
  "tags",
  "booru",
  "illustration",
  "イラスト",
  "search",
  "download",
  "read",
  "post",
  "trending",
  "latest",
  "anime",
  "manga",
  "game",
]);

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

export function runtimeSearchDocuments(): CommandSearchDocument[] {
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
      feasibility: commandFeasibilityProfile(
        buildCoreCommandContract({ command: doc }),
      ),
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
      ...(doc.feasibility ? { feasibility: doc.feasibility } : {}),
      terms,
      termCount: terms.length,
    });
  }

  const siteLookup = new Set(siteSet);
  const sitePhrases = Array.from(siteSet, (site) => ({
    site,
    phrase: normalizeSitePhrase(site),
  })).filter((entry) => entry.phrase.includes(" "));

  const N = documents.length;
  const avgDl =
    N > 0 ? documents.reduce((sum, d) => sum + d.termCount, 0) / N : 0;

  // Build the positional inverted index. Frequency arrays are aligned with
  // postings so retrieval can accumulate both lexical scores directly from
  // query-term posting lists instead of rebuilding a term-frequency Map once
  // per candidate and per scoring model.
  const postings = new Map<string, number[]>();
  const frequencies = new Map<string, number[]>();
  const documentTermFrequencies: Array<Map<string, number>> = [];
  for (let i = 0; i < documents.length; i++) {
    const termFrequencies = new Map<string, number>();
    for (const term of documents[i].terms) {
      termFrequencies.set(term, (termFrequencies.get(term) ?? 0) + 1);
    }
    documentTermFrequencies.push(termFrequencies);
    for (const [term, frequency] of termFrequencies) {
      const posting = postings.get(term);
      const termFrequency = frequencies.get(term);
      if (posting && termFrequency) {
        posting.push(i);
        termFrequency.push(frequency);
      } else {
        postings.set(term, [i]);
        frequencies.set(term, [frequency]);
      }
    }
  }

  // Compute IDF for each term
  const idf = new Map<string, number>();
  for (const [term, docs] of postings) {
    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const df = docs.length;
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  return {
    postings,
    frequencies,
    idf,
    documents: documents.map((d, index) => ({
      id: d.id,
      site: d.site,
      command: d.command,
      description: d.description,
      ...(d.category ? { category: d.category } : {}),
      ...(d.feasibility ? { feasibility: d.feasibility } : {}),
      terms: d.terms,
      bm25LengthNorm:
        K1 * (1 - B + B * (avgDl === 0 ? 0 : d.termCount / avgDl)),
      tfidfNorm: documentTfidfNorm(
        d.termCount,
        documentTermFrequencies[index]!,
        idf,
      ),
      normalizedCommand: normalizeSitePhrase(d.command),
      normalizedDescription: normalizeSitePhrase(d.description),
    })),
    avgDl,
    N,
    siteLookup,
    sitePhrases,
  };
}

function documentTfidfNorm(
  termCount: number,
  termFrequencies: ReadonlyMap<string, number>,
  idf: ReadonlyMap<string, number>,
): number {
  if (termCount === 0) return 0;
  let normSquare = 0;
  for (const [term, count] of termFrequencies) {
    const termIdf = idf.get(term);
    if (termIdf === undefined) continue;
    const weight = (count / termCount) * termIdf;
    normSquare += weight * weight;
  }
  return Math.sqrt(normSquare);
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
  const normalizedQuery = normalizeSitePhrase(query);

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
    if (index.siteLookup.has(lowerToken)) {
      siteHints.push(lowerToken);
    }

    // Check category alias
    const catMatch =
      CATEGORY_ALIASES.get(token) ?? CATEGORY_ALIASES.get(token.toLowerCase());
    if (catMatch) categoryHints.push(catMatch);
  }

  const queryTerms = [...new Set(expandedTerms.map((t) => t.toLowerCase()))];
  const queryTermSet = new Set(queryTerms);
  const categoryFilter = options.category;
  const taskIntentFrame = resolveTaskIntentFrame(query);
  siteHints.push(...taskIntentFrame.site_hints);
  const effectiveTaskSiteHints = [
    ...new Set([...siteHints, ...sitePhraseHints]),
  ];
  const intentFrame = resolveIntentFrame({
    query,
    queryTerms,
    siteHints: effectiveTaskSiteHints,
  });

  // Step 3: Accumulate lexical scores directly from the inverted index. The
  // dense score vectors are small (one slot per command), avoid candidate-
  // local Maps, and touch only documents named by query-term posting lists.
  const candidateSet = new Set<number>();
  const bm25Scores = new Float64Array(index.N);
  const tfidfDots = new Float64Array(index.N);
  let queryNormSquare = 0;
  for (const qt of queryTerms) {
    const postings = index.postings.get(qt);
    const frequencies = index.frequencies.get(qt);
    const termIdf = index.idf.get(qt);
    if (!postings || !frequencies || termIdf === undefined) continue;
    queryNormSquare += termIdf * termIdf;
    for (let i = 0; i < postings.length; i++) {
      const docIdx = postings[i]!;
      const frequency = frequencies[i]!;
      const doc = index.documents[docIdx]!;
      candidateSet.add(docIdx);
      bm25Scores[docIdx] +=
        termIdf * ((frequency * (K1 + 1)) / (frequency + doc.bm25LengthNorm));
      tfidfDots[docIdx] += termIdf * ((frequency / doc.terms.length) * termIdf);
    }
  }
  const queryNorm = Math.sqrt(queryNormSquare);

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
  // Alias expansion can intentionally name several independent providers
  // (for example an entity lookup spanning AniList, Jikan, Bangumi, and
  // Moegirl). In that mode, retrieving only K commands lets one adapter's
  // sibling commands crowd every other provider out before result shaping.
  const expandedProviderCount = queryTerms.reduce(
    (count, term) => count + (index.siteLookup.has(term) ? 1 : 0),
    0,
  );
  const hasExplicitAction = rawTokens.some((term) =>
    PROVIDER_DIVERSITY_ACTION_TERMS.has(term),
  );
  const diversifyProviders =
    siteHints.length === 0 && expandedProviderCount >= 3 && !hasExplicitAction;
  const candidateLimit = diversifyProviders
    ? Math.min(index.N, Math.max(boundedLimit, boundedLimit * 4))
    : boundedLimit;
  const topScored = new BoundedTopK<ScoredCandidate>(
    candidateLimit,
    compareBestCandidate,
  );
  let scoreOrdinal = 0;

  for (const idx of candidateSet) {
    const doc = index.documents[idx];
    const docCategory = documentCategory(doc);
    if (categoryFilter && docCategory !== categoryFilter) continue;
    const feasibilityDecision = options.requirements
      ? doc.feasibility
        ? evaluateFeasibilityProfile(
            doc.site,
            doc.command,
            doc.feasibility,
            options.requirements,
          )
        : evaluateCommandFeasibility(
            doc.site,
            doc.command,
            options.requirements,
          )
      : undefined;
    if (feasibilityDecision && !feasibilityDecision.contract_compatible) {
      continue;
    }
    const intentDecision = evaluateIntentFrame(intentFrame, doc);
    if (intentDecision.blocked) continue;

    // Hybrid base: alpha-blend BM25 and TF-IDF cosine similarity.
    // BM25 scores are unbounded; cosine is [0,1] and is scaled by a fixed
    // ×10 so the 20/80 blend keeps both regimes on comparable magnitudes
    // (empirically tuned against the eval suite; NOT normalized per-query).
    const bm25 = bm25Scores[idx]!;
    const normProduct = queryNorm * doc.tfidfNorm;
    const tfidf = normProduct === 0 ? 0 : tfidfDots[idx]! / normProduct;
    let score = ALPHA_BM25 * bm25 + ALPHA_TFIDF * tfidf * 10;

    // Boost: exact site name match
    if (siteHints.includes(doc.site)) {
      score += BOOST_SITE_EXACT;
    }
    if (sitePhraseHints.includes(doc.site)) {
      score += BOOST_SITE_PHRASE;
    }

    // Boost: expanded query term hits the site or command name. The site
    // branch intentionally co-fires with BOOST_SITE_EXACT on direct site
    // queries AND fires alone when a DOMAIN_ALIASES expansion lands on a
    // site name (e.g. 漫画→mangadex) — that second path is the zh-domain
    // site-routing channel the eval suite depends on.
    const wholeQueryMatchesCommand =
      normalizedQuery.length > 0 && normalizedQuery === doc.normalizedCommand;
    if (wholeQueryMatchesCommand) score += BOOST_CMD_EXACT;
    let commandTokenMatched = false;
    for (const qt of queryTerms) {
      if (qt === doc.site) score += BOOST_SITE_ALIAS;
      if (
        !wholeQueryMatchesCommand &&
        !commandTokenMatched &&
        qt === doc.command
      ) {
        score += BOOST_CMD_TOKEN;
        commandTokenMatched = true;
      }
      if (rawTokens.length === 1 && doc.command.includes(qt) && qt.length > 2) {
        score += BOOST_CMD_PARTIAL;
      }
    }

    // A multi-token phrase in the task description is stronger evidence than
    // one generic action token such as "user" or "read".
    if (
      normalizedQuery.includes(" ") &&
      hasPhrase(doc.normalizedDescription, normalizedQuery)
    ) {
      score += BOOST_DESCRIPTION_PHRASE;
    }
    // Boost: category match
    if (categoryHints.includes(docCategory)) {
      score += BOOST_CATEGORY;
    }

    score += intentBoost(doc, queryTermSet, effectiveTaskSiteHints);
    score += intentEntityCommandBoost(
      taskIntentFrame,
      doc.site,
      doc.command,
      effectiveTaskSiteHints,
    );
    score += intentDecision.boost;
    if (feasibilityDecision?.compatibility === "unknown") {
      score -= 24 + feasibilityDecision.uncertain_by.length * 4;
    } else if (
      options.requirements?.operator &&
      feasibilityDecision?.compatibility === "compatible" &&
      feasibilityDecision.contract?.operator === options.requirements.operator
    ) {
      score += 16;
    }
    if (categoryFilter && queryTerms.length === 0) score += BOOST_CATEGORY;
    score *= appActionScorePrior(doc, queryTermSet);

    if (score <= 0) continue;
    topScored.add({
      idx,
      score,
      ordinal: scoreOrdinal,
      ...(feasibilityDecision?.contract
        ? { feasibility: feasibilityDecision.contract }
        : {}),
    });
    scoreOrdinal += 1;
  }

  // Step 5: Sort the bounded heap and return top-K.
  const ranked = topScored.values();
  const topK = diversifyProviders
    ? takeProviderDiverseCandidates(index, ranked, boundedLimit)
    : ranked;

  return topK.map(({ idx, score, feasibility: evaluatedFeasibility }) => {
    const doc = index.documents[idx];
    const feasibility =
      doc.feasibility ??
      evaluatedFeasibility ??
      evaluateCommandFeasibility(doc.site, doc.command, {}).contract;
    return {
      site: doc.site,
      command: doc.command,
      description: doc.description,
      score: Math.round(score * 100) / 100,
      usage: buildUsageExample(doc.site, doc.command),
      category: documentCategory(doc),
      ...(feasibility ? { feasibility } : {}),
    };
  });
}

function takeProviderDiverseCandidates(
  index: SearchIndex,
  ranked: readonly ScoredCandidate[],
  limit: number,
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  const seenSites = new Set<string>();
  for (const candidate of ranked) {
    const site = index.documents[candidate.idx]?.site;
    if (!site || seenSites.has(site)) continue;
    seenSites.add(site);
    selected.push(candidate);
    if (selected.length === limit) return selected;
  }
  // A small catalog may have fewer providers than the requested result count;
  // fill the remaining slots in original score order without duplicates.
  const selectedIds = new Set(selected.map((candidate) => candidate.idx));
  for (const candidate of ranked) {
    if (selectedIds.has(candidate.idx)) continue;
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}

function addSiteCandidates(
  index: SearchIndex,
  site: string,
  candidateSet: Set<number>,
): void {
  for (const docIdx of index.postings.get(site) ?? []) {
    if (index.documents[docIdx]?.site === site) candidateSet.add(docIdx);
  }
}

function addCategoryCandidates(
  index: SearchIndex,
  category: string,
  candidateSet: Set<number>,
): void {
  for (const docIdx of index.postings.get(category) ?? []) {
    const doc = index.documents[docIdx];
    if (doc && documentCategory(doc) === category) candidateSet.add(docIdx);
  }
}

function compareBestCandidate(
  left: ScoredCandidate,
  right: ScoredCandidate,
): number {
  return right.score - left.score || left.ordinal - right.ordinal;
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
  let offset = 0;
  while (offset <= haystack.length - phrase.length) {
    const index = haystack.indexOf(phrase, offset);
    if (index < 0) return false;
    const end = index + phrase.length;
    if (
      (index === 0 || haystack.charCodeAt(index - 1) === 32) &&
      (end === haystack.length || haystack.charCodeAt(end) === 32)
    ) {
      return true;
    }
    offset = index + 1;
  }
  return false;
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
  invalidateMacosDynamicCache();
}
