/**
 * @owner       src::engine::retrieval-relevance
 * @does        Parses natural retrieval queries and scores candidate title, summary, tags, and URL fields without source-specific vocabulary.
 * @needs       Unicode normalization and deterministic token/phrase matching.
 * @feeds       arXiv search precision and AI cross-source relevance ranking.
 * @breaks      Dropped technical tokens, qualifier leakage, or source-specific weights can hide exact evidence or reward broad unrelated rows.
 * @invariants  Matching is Unicode-normalized and case-insensitive; query qualifiers and grammatical stop words never increase relevance; score ties retain caller order.
 * @side-effects None.
 * @perf        O(Q * F) per candidate for bounded query tokens and text fields.
 * @concurrency Pure and reentrant.
 * @test        tests/unit/engine/retrieval-relevance.test.ts, src/adapters/arxiv/papers.test.ts, tests/unit/adapters/ai-intelligence.test.ts
 * @stability   experimental
 * @since       2026-07-18
 */

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "latest",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "with",
]);

const QUERY_QUALIFIER =
  /^(?:site|repo|author|title|cat|au|ti|abs|all|after|before|since|updated|pushed):/i;
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:[+#._/-][\p{L}\p{N}+#._/-]+)*/gu;

export interface RetrievalQueryAnalysis {
  terms: string[];
  phrases: string[];
  minimumMatchedTerms: number;
}

export interface RetrievalCandidateFields {
  title?: string;
  summary?: string;
  tags?: readonly string[];
  url?: string;
}

export interface RetrievalRelevance {
  score: number;
  matchedTerms: number;
  qualifies: boolean;
}

export function splitRetrievalDisjunction(query: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (
      !quoted &&
      query.slice(index, index + 2).toUpperCase() === "OR" &&
      /\s/.test(query[index - 1] ?? "") &&
      /\s/.test(query[index + 2] ?? "")
    ) {
      const alternative = query.slice(start, index).trim();
      if (alternative) alternatives.push(alternative);
      start = index + 2;
      index += 1;
    }
  }
  const finalAlternative = query.slice(start).trim();
  if (finalAlternative) alternatives.push(finalAlternative);
  return alternatives.length > 0 ? alternatives : [query.trim()];
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function tokens(value: string): string[] {
  return unique(
    [...value.matchAll(TOKEN_PATTERN)]
      .map((match) => normalized(match[0]))
      .filter(
        (token) =>
          token.length > 0 &&
          !QUERY_STOP_WORDS.has(token) &&
          !QUERY_QUALIFIER.test(token),
      ),
  );
}

export function analyzeRetrievalQuery(query: string): RetrievalQueryAnalysis {
  const phrases = unique(
    [...query.matchAll(/"([^"\n]+)"/g)]
      .map((match) => normalized(match[1]))
      .filter(Boolean),
  );
  const withoutPhrases = query
    .replaceAll(/"[^"\n]+"/g, " ")
    .replaceAll(
      /\b(?:site|repo|author|title|cat|au|ti|abs|all|after|before|since|updated|pushed):[^\s()]*/gi,
      " ",
    );
  const terms = unique([...phrases.flatMap(tokens), ...tokens(withoutPhrases)]);
  const hasDisjunction = /(?:^|\s)OR(?:\s|$)/i.test(query);
  const minimumMatchedTerms =
    terms.length <= 1 ? 0 : hasDisjunction ? 1 : Math.min(2, terms.length);
  return { terms, phrases, minimumMatchedTerms };
}

export function isSpecificSingleTermQuery(
  query: string,
  analysis = analyzeRetrievalQuery(query),
): boolean {
  if (analysis.terms.length !== 1) return false;
  const raw = query.trim().replace(/^"|"$/g, "");
  const uppercaseCount = [...raw].filter((character) =>
    /[A-Z]/.test(character),
  ).length;
  return (
    /[^\p{ASCII}]/u.test(raw) ||
    /\d|[+#._/-]/u.test(raw) ||
    uppercaseCount >= 2 ||
    /[a-z][A-Z]/.test(raw)
  );
}

function termWeight(term: string): number {
  const lengthWeight = Math.min(term.length, 12) / 8;
  const technicalWeight = /\d|[+#._/-]/u.test(term) ? 1 : 0;
  return 1 + lengthWeight + technicalWeight;
}

function termAppears(text: string, term: string): boolean {
  if (/[^\p{ASCII}]/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(text);
}

export function scoreRetrievalCandidate(
  analysis: RetrievalQueryAnalysis,
  fields: RetrievalCandidateFields,
  options: { requireAllTerms?: boolean } = {},
): RetrievalRelevance {
  const title = normalized(fields.title ?? "");
  const summary = normalized(fields.summary ?? "");
  const tags = normalized((fields.tags ?? []).join(" "));
  const url = normalized(fields.url ?? "");
  let score = 0;
  let matchedTerms = 0;

  for (const term of analysis.terms) {
    const weight = termWeight(term);
    const inTitle = termAppears(title, term);
    const inSummary = termAppears(summary, term);
    const inTags = termAppears(tags, term);
    const inUrl = termAppears(url, term);
    if (inTitle || inSummary || inTags || inUrl) matchedTerms += 1;
    if (inTitle) score += 5 * weight;
    if (inSummary) score += 2 * weight;
    if (inTags) score += 3 * weight;
    if (inUrl) score += weight;
  }

  const phraseMatches = analysis.phrases.map((phrase) => {
    if (title.includes(phrase)) {
      score += 12;
      return true;
    }
    if (summary.includes(phrase) || tags.includes(phrase)) {
      score += 6;
      return true;
    }
    return url.includes(phrase);
  });
  if (analysis.terms.length > 0) {
    score += (matchedTerms / analysis.terms.length) * 4;
  }

  const termsQualify = options.requireAllTerms
    ? matchedTerms === analysis.terms.length
    : matchedTerms >= analysis.minimumMatchedTerms;
  const phrasesQualify = phraseMatches.every(Boolean);
  return {
    score: Number(score.toFixed(6)),
    matchedTerms,
    qualifies: termsQualify && phrasesQualify,
  };
}

export function scoreRetrievalAlternatives(
  analyses: readonly RetrievalQueryAnalysis[],
  fields: RetrievalCandidateFields,
  options: { requireAllTerms?: boolean } = {},
): RetrievalRelevance {
  const scores = analyses.map((analysis) =>
    scoreRetrievalCandidate(analysis, fields, options),
  );
  const best = scores.sort(
    (left, right) =>
      Number(right.qualifies) - Number(left.qualifies) ||
      right.score - left.score,
  )[0];
  return best ?? { score: 0, matchedTerms: 0, qualifies: false };
}
