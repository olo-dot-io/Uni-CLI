/**
 * @owner       src::discovery::site-resolver
 * @does        Resolve exact, aliased, phrase, and bounded typo site mentions against a live command catalog.
 * @needs       canonical site ids and the maintained site alias table
 * @feeds       discovery search and intent compilation
 * @breaks      An ambiguous typo must never become a provider constraint or outrank an explicit site mention.
 * @invariants  Exact and phrase matches outrank fuzzy matches; fuzzy matches require one unique nearest site; lookup never invents a site outside the supplied catalog.
 * @side-effects None.
 * @perf        Construction is O(dictionary * deletion variants); lookup is O(query tokens * deletion variants + bounded candidate distance checks).
 * @concurrency Immutable after construction.
 * @test        tests/unit/site-resolver.test.ts, tests/unit/search.test.ts
 * @stability   experimental
 * @since       2026-08-10
 */

import {
  ACTION_ALIASES,
  CATEGORY_ALIASES,
  DOMAIN_ALIASES,
  SITE_ALIASES,
} from "./aliases.js";

export interface FuzzySiteMatch {
  readonly site: string;
  readonly token: string;
  readonly matched: string;
  readonly distance: number;
}

export interface SiteResolution {
  readonly exact: readonly string[];
  readonly phrase: readonly string[];
  readonly fuzzy: readonly FuzzySiteMatch[];
}

interface DictionaryTerm {
  readonly term: string;
  readonly site: string;
}

const MAX_EDIT_DISTANCE = 2;
const MIN_FUZZY_TOKEN_LENGTH = 5;
const ASCII_WORD = /^[a-z0-9]+$/;
const CANONICAL_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["hacker news", "hackernews"],
  ["linux do", "linux-do"],
  ["little red book", "xiaohongshu"],
];

export class SiteResolver {
  private readonly exact = new Map<string, Set<string>>();
  private readonly phrases: Array<{ phrase: string; site: string }> = [];
  private readonly deletionIndex = new Map<string, DictionaryTerm[]>();

  constructor(sites: Iterable<string>) {
    const catalog = new Set(sites);
    for (const site of catalog) {
      this.addIdentity(site, site);
      const compact = compactSiteTerm(site);
      if (compact !== site) this.addIdentity(compact, site);
    }
    for (const [alias, site] of SITE_ALIASES) {
      if (catalog.has(site)) this.addIdentity(alias, site);
    }
    for (const [phrase, site] of CANONICAL_PHRASES) {
      if (catalog.has(site)) this.addIdentity(phrase, site);
    }
  }

  resolve(query: string, tokens: readonly string[]): SiteResolution {
    const exact = new Set<string>();
    const phrase = new Set<string>();
    const fuzzy: FuzzySiteMatch[] = [];
    const normalizedQuery = normalizeSiteText(query);

    for (const token of tokens) {
      const normalized = normalizeSiteText(token);
      for (const site of this.exact.get(normalized) ?? []) exact.add(site);
    }
    for (const entry of this.phrases) {
      if (hasBoundedPhrase(normalizedQuery, entry.phrase)) {
        phrase.add(entry.site);
      }
    }

    for (const token of tokens) {
      const normalized = compactSiteTerm(token);
      if (
        normalized.length < MIN_FUZZY_TOKEN_LENGTH ||
        !ASCII_WORD.test(normalized) ||
        this.exact.has(normalized) ||
        isSemanticVocabulary(normalized)
      ) {
        continue;
      }
      const match = this.nearestUnique(normalized);
      if (match && !exact.has(match.site) && !phrase.has(match.site)) {
        fuzzy.push({ ...match, token });
      }
    }

    return {
      exact: [...exact],
      phrase: [...phrase],
      fuzzy,
    };
  }

  private addIdentity(value: string, site: string): void {
    const normalized = normalizeSiteText(value);
    if (!normalized) return;
    addToSetMap(this.exact, normalized, site);
    if (normalized.includes(" ")) {
      this.phrases.push({ phrase: normalized, site });
    }

    const compact = compactSiteTerm(value);
    if (compact.length < MIN_FUZZY_TOKEN_LENGTH || !ASCII_WORD.test(compact)) {
      return;
    }
    const entry = { term: compact, site };
    for (const deletion of generateDeletes(compact, MAX_EDIT_DISTANCE)) {
      const entries = this.deletionIndex.get(deletion);
      if (entries) {
        if (
          !entries.some(
            (candidate) =>
              candidate.term === entry.term && candidate.site === entry.site,
          )
        ) {
          entries.push(entry);
        }
      } else {
        this.deletionIndex.set(deletion, [entry]);
      }
    }
  }

  private nearestUnique(
    query: string,
  ): { site: string; matched: string; distance: number } | undefined {
    const candidates = new Map<string, DictionaryTerm>();
    for (const deletion of generateDeletes(query, MAX_EDIT_DISTANCE)) {
      for (const candidate of this.deletionIndex.get(deletion) ?? []) {
        candidates.set(`${candidate.site}\0${candidate.term}`, candidate);
      }
    }

    const allowedDistance = query.length < 6 ? 1 : MAX_EDIT_DISTANCE;
    let bestDistance = allowedDistance + 1;
    let best: DictionaryTerm[] = [];
    for (const candidate of candidates.values()) {
      const distance = damerauLevenshtein(
        query,
        candidate.term,
        allowedDistance,
      );
      if (distance > allowedDistance) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [candidate];
      } else if (distance === bestDistance) {
        best.push(candidate);
      }
    }
    const sites = new Set(best.map((candidate) => candidate.site));
    if (sites.size !== 1 || bestDistance > allowedDistance) return undefined;
    const candidate = best
      .filter((entry) => entry.site === [...sites][0])
      .sort((left, right) => left.term.length - right.term.length)[0];
    return candidate
      ? {
          site: candidate.site,
          matched: candidate.term,
          distance: bestDistance,
        }
      : undefined;
  }
}

function addToSetMap(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const values = map.get(key);
  if (values) values.add(value);
  else map.set(key, new Set([value]));
}

function generateDeletes(value: string, maxDistance: number): Set<string> {
  const deletes = new Set([value]);
  let frontier = new Set([value]);
  for (let distance = 0; distance < maxDistance; distance++) {
    const next = new Set<string>();
    for (const term of frontier) {
      for (let index = 0; index < term.length; index++) {
        const deletion = term.slice(0, index) + term.slice(index + 1);
        if (!deletes.has(deletion)) {
          deletes.add(deletion);
          next.add(deletion);
        }
      }
    }
    frontier = next;
  }
  return deletes;
}

function damerauLevenshtein(
  left: string,
  right: string,
  limit: number,
): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previousPrevious = new Uint16Array(right.length + 1);
  let previous = new Uint16Array(right.length + 1);
  for (let column = 0; column <= right.length; column++) {
    previous[column] = column;
  }

  for (let row = 1; row <= left.length; row++) {
    const current = new Uint16Array(right.length + 1);
    current[0] = row;
    let rowMinimum = current[0];
    for (let column = 1; column <= right.length; column++) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + substitution,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        value = Math.min(value, previousPrevious[column - 2]! + 1);
      }
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length] ?? limit + 1;
}

function normalizeSiteText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactSiteTerm(value: string): string {
  return normalizeSiteText(value).replaceAll(" ", "");
}

function hasBoundedPhrase(value: string, phrase: string): boolean {
  return ` ${value} `.includes(` ${phrase} `);
}

function isSemanticVocabulary(token: string): boolean {
  return (
    ACTION_ALIASES.has(token) ||
    DOMAIN_ALIASES.has(token) ||
    CATEGORY_ALIASES.has(token)
  );
}
