/**
 * @owner   src/discovery/intents.ts
 * @does    Score natural-language intent signals that sit above raw BM25/TF-IDF lexical matching.
 * @needs   Search document metadata, site category map, vertical command capability knowledge
 * @feeds   src/discovery/search.ts
 * @breaks  Weak or stale boosts make agents discover plausible but wrong commands for broad user intents.
 */

import { SITE_CATEGORIES } from "./aliases.js";
import type { SearchIndex } from "./search.js";

const BOOST_RUN_TRACE_INTENT = 45.0;
const BOOST_ACG_CREATOR_INTENT = 36.0;
const BOOST_ACG_MEDIA_TREND_INTENT = 42.0;
const BOOST_WEATHER_INTENT = 30.0;
const BOOST_SCHOLARLY_INTENT = 34.0;
const BOOST_SCHOLARLY_SEARCH = 12.0;
const BOOST_SCHOLARLY_PDF = 10.0;
const BOOST_SCHOLARLY_VENUE_SOURCE = 38.0;

const SCHOLARLY_WORKFLOW_COMMANDS = new Set([
  "pdf/read",
  "hf/paper",
  "hf/top",
  "huggingface-papers/search",
  "huggingface-papers/daily",
]);
const SCHOLARLY_NON_BLOCKING_SITE_HINTS = new Set(["agents", "pdf"]);

export function intentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
  siteHints: string[],
): number {
  return (
    architectureIntentBoost(doc, queryTerms) +
    acgCreatorIntentBoost(doc, queryTerms) +
    acgMediaTrendIntentBoost(doc, queryTerms) +
    weatherIntentBoost(doc, queryTerms) +
    scholarlyIntentBoost(doc, queryTerms, siteHints)
  );
}

function architectureIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  const terms = new Set(queryTerms);
  const runTraceIntent =
    (hasAny(terms, ["run", "runs"]) &&
      hasAny(terms, [
        "trace",
        "traces",
        "recorded",
        "record",
        "replay",
        "probe",
      ])) ||
    (terms.has("trace") && hasAny(terms, ["evidence", "audit", "lease"]));
  if (runTraceIntent && doc.site === "runs") {
    return BOOST_RUN_TRACE_INTENT;
  }
  return 0;
}

function acgCreatorIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  const terms = new Set(queryTerms);
  const creatorIntent = hasAny(terms, [
    "author",
    "authors",
    "artist",
    "artists",
    "creator",
    "creators",
    "mangaka",
    "illustrator",
    "staff",
    "people",
  ]);
  const acgIntent = hasAny(terms, [
    "acg",
    "anime",
    "manga",
    "comic",
    "doujin",
    "illustration",
    "pixiv",
    "danbooru",
    "mangadex",
    "anilist",
    "jikan",
    "bangumi",
    "vndb",
    "dlsite",
  ]);
  const acgCreatorCommand =
    (doc.site === "mangadex" && doc.command === "authors") ||
    (doc.site === "dlsite" && doc.command === "creator") ||
    (doc.site === "anilist" && doc.command === "staff") ||
    (doc.site === "jikan" && doc.command === "people") ||
    (doc.site === "vndb" && doc.command === "staff");

  return creatorIntent && acgIntent && acgCreatorCommand
    ? BOOST_ACG_CREATOR_INTENT
    : 0;
}

function acgMediaTrendIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  const terms = new Set(queryTerms);
  const acgMediaIntent =
    hasAny(terms, [
      "acg",
      "anime",
      "manga",
      "comic",
      "doujin",
      "galgame",
      "bishoujo",
      "eroge",
      "vn",
      "bangumi",
      "anilist",
      "jikan",
      "kitsu",
      "vndb",
      "mangadex",
      "dlsite",
      "pixiv",
      "danbooru",
    ]) ||
    (terms.has("visual") && terms.has("novel"));
  const rankingOrFreshnessIntent =
    hasAny(terms, [
      "trending",
      "hot",
      "popular",
      "top",
      "rank",
      "ranking",
      "recent",
      "latest",
      "newest",
      "year",
    ]) || [...terms].some((term) => /^20[0-9]{2}$/.test(term));
  const acgMediaCommand =
    (doc.site === "anilist" &&
      (doc.command === "anime" || doc.command === "manga")) ||
    (doc.site === "jikan" &&
      (doc.command === "anime" || doc.command === "manga")) ||
    (doc.site === "kitsu" &&
      (doc.command === "anime" || doc.command === "manga")) ||
    (doc.site === "bangumi" &&
      (doc.command === "anime" ||
        doc.command === "book" ||
        doc.command === "game")) ||
    (doc.site === "mangadex" && doc.command === "manga") ||
    (doc.site === "vndb" &&
      (doc.command === "search" || doc.command === "releases")) ||
    (doc.site === "dlsite" &&
      ["search", "manga", "cg", "game"].includes(doc.command));

  return acgMediaIntent && rankingOrFreshnessIntent && acgMediaCommand
    ? BOOST_ACG_MEDIA_TREND_INTENT
    : 0;
}

function weatherIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  const terms = new Set(queryTerms);
  const weatherIntent = hasAny(terms, ["weather", "forecast", "temperature"]);
  const weatherCommand =
    (doc.site === "wttr" &&
      (doc.command === "forecast" || doc.command === "now")) ||
    (doc.site === "qweather" &&
      (doc.command === "forecast" || doc.command === "now"));

  return weatherIntent && weatherCommand ? BOOST_WEATHER_INTENT : 0;
}

function scholarlyIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
  siteHints: string[],
): number {
  const terms = new Set(queryTerms);
  const scholarlyIntent = hasAny(terms, [
    "academic",
    "scholar",
    "scholarly",
    "research",
    "paper",
    "papers",
    "thesis",
    "literature",
    "publication",
    "bibliography",
    "citation",
    "citations",
    "reference",
    "references",
    "doi",
    "journal",
    "conference",
    "proceedings",
    "experiment",
    "experiments",
    "method",
    "methods",
    "results",
    "conclusion",
  ]);
  if (!scholarlyIntent) return 0;

  const explicitNonScholarlySite = siteHints.some(
    (site) =>
      !SCHOLARLY_NON_BLOCKING_SITE_HINTS.has(site) &&
      SITE_CATEGORIES.get(site) !== "scholarly",
  );
  if (explicitNonScholarlySite) return 0;

  const key = `${doc.site}/${doc.command}`;
  const isScholarlyCommand =
    SITE_CATEGORIES.get(doc.site) === "scholarly" ||
    SCHOLARLY_WORKFLOW_COMMANDS.has(key);
  if (!isScholarlyCommand) return 0;

  let boost = BOOST_SCHOLARLY_INTENT;
  boost += scholarlyVenueSourceBoost(doc, terms);
  boost += scholarlyProviderSourceBoost(doc, terms);
  const searchIntent = hasAny(terms, [
    "search",
    "find",
    "query",
    "lookup",
    "retrieve",
    "recent",
    "latest",
    "trending",
  ]);
  if (
    searchIntent &&
    ["search", "recent", "trending", "daily", "author", "venue"].includes(
      doc.command,
    )
  ) {
    boost += BOOST_SCHOLARLY_SEARCH;
  }

  const pdfIntent = hasAny(terms, ["pdf", "download", "save", "read"]);
  if (
    pdfIntent &&
    ((doc.site === "arxiv" && doc.command === "download") ||
      (doc.site === "pdf" && doc.command === "read"))
  ) {
    boost += BOOST_SCHOLARLY_PDF;
  }

  return boost;
}

function scholarlyVenueSourceBoost(
  doc: SearchIndex["documents"][number],
  terms: Set<string>,
): number {
  const wantsPmlr = hasAny(terms, ["pmlr", "icml"]);
  if (wantsPmlr && doc.site === "pmlr") return BOOST_SCHOLARLY_VENUE_SOURCE;

  const wantsCvf = hasAny(terms, ["cvf", "cvpr", "iccv", "eccv", "wacv"]);
  if (wantsCvf && doc.site === "cvf") return BOOST_SCHOLARLY_VENUE_SOURCE;

  const wantsAcl = hasAny(terms, [
    "acl",
    "anthology",
    "emnlp",
    "naacl",
    "coling",
  ]);
  if (wantsAcl && doc.site === "acl-anthology")
    return BOOST_SCHOLARLY_VENUE_SOURCE;

  const wantsNeurips = hasAny(terms, ["neurips", "nips"]);
  if (wantsNeurips && doc.site === "neurips")
    return BOOST_SCHOLARLY_VENUE_SOURCE;

  return 0;
}

function scholarlyProviderSourceBoost(
  doc: SearchIndex["documents"][number],
  terms: Set<string>,
): number {
  const doiIntent = terms.has("doi");
  const pdfIntent = hasAny(terms, ["pdf", "download", "save", "read"]);
  const openAccessIntent =
    terms.has("open") || terms.has("access") || terms.has("oa");

  if (doiIntent && doc.site === "crossref") return 34.0;
  if ((doiIntent || openAccessIntent || pdfIntent) && doc.site === "unpaywall")
    return 34.0;
  if (doiIntent && doc.site === "openalex") return 18.0;
  if (terms.has("citation") && doc.site === "semantic-scholar") return 20.0;
  if (terms.has("citations") && doc.site === "semantic-scholar") return 20.0;
  return 0;
}

function hasAny(terms: Set<string>, values: string[]): boolean {
  return values.some((value) => terms.has(value));
}
