/**
 * @owner   src/discovery/intents.ts
 * @does    Owns discovery semantic routing: hard intent frames plus soft ranking signals above lexical BM25/TF-IDF.
 * @needs   Search document metadata, site category map, vertical command capability knowledge.
 * @feeds   src/discovery/search.ts
 * @breaks  Over-broad hard frames suppress correct lexical matches; stale soft boosts make plausible wrong commands rank first.
 * @invariants Hard blocks only apply to high-confidence frames; soft boosts never remove candidates.
 * @side-effects none.
 * @perf    O(query terms + constant-size frame tables + one document semantic pass).
 * @concurrency pure and reentrant.
 * @test    tests/unit/search.test.ts, tests/unit/search-eval.test.ts
 * @stability Public discovery behavior.
 * @since   2026-06-01
 */

import { SITE_CATEGORIES } from "./aliases.js";
import type { SearchIndex } from "./search.js";

type SearchDocument = SearchIndex["documents"][number];

export type IntentFrame =
  | {
      kind: "audio.playback";
      preferredSites: readonly string[];
    }
  | {
      kind: "travel.lodging";
      preferredSites: readonly string[];
    };

export interface IntentKernelInput {
  query: string;
  queryTerms: readonly string[];
  siteHints: readonly string[];
}

export interface IntentKernelDecision {
  blocked: boolean;
  boost: number;
}

const AUDIO_PLAYBACK_STRONG_BOOST = 72;
const AUDIO_CATEGORY_BOOST = 46;
const AUDIO_SITE_HINT_BOOST = 20;
const TRAVEL_LODGING_COMMAND_BOOST = 30;

const AUDIO_SITES = ["spotify", "netease-music"] as const;
const AUDIO_QUERY_SITE_HINTS = new Set<string>([
  "spotify",
  "netease-music",
  "apple-music",
  "apple-podcasts",
  "xiaoyuzhou",
]);
const AUDIO_BLOCKED_CATEGORIES = new Set([
  "finance",
  "shopping",
  "travel",
  "jobs",
  "patent",
  "scholarly",
  "social",
  "news",
]);
const AUDIO_PLAYBACK_COMMANDS = new Map<string, number>([
  ["play-track", AUDIO_PLAYBACK_STRONG_BOOST],
  ["queue", 34],
  ["search", 22],
  ["play", 12],
  ["now-playing", 8],
  ["status", 8],
]);
const AUDIO_SECONDARY_PENALTY = new Map<string, number>([
  ["play-liked", -16],
  ["playlists", -10],
  ["top-tracks", -8],
]);

const MEDIA_PLAYBACK_TRIGGER =
  /(^|\s)(play|listen)\b|我想听|想听|听一下|收听|播放|放一下/u;
const MEDIA_SEARCH_TRIGGER =
  /\b(search|find|lookup|query)\b|搜索|查找|查询|检索/u;
const MEDIA_STATUS_TRIGGER =
  /\b(now\s+playing|currently\s+playing|status)\b|正在播放/u;
const NON_AUDIO_PLAY_HINT =
  /\b(video|movie|game|chess|youtube|bilibili|douyin|tiktok|twitch)\b|视频|电影|游戏|棋/u;

const TRAVEL_SITES = ["ctrip"] as const;
const TRAVEL_LODGING_TERMS = new Set([
  "hotel",
  "hotels",
  "lodging",
  "stay",
  "stays",
  "checkin",
  "checkout",
  "旅馆",
  "酒店",
  "住宿",
  "入住",
  "退房",
]);

const BOOST_RUN_TRACE_INTENT = 45.0;
const BOOST_ACG_CREATOR_INTENT = 36.0;
const BOOST_ACG_MEDIA_TREND_INTENT = 42.0;
const BOOST_WEATHER_INTENT = 30.0;
const BOOST_SCHOLARLY_INTENT = 34.0;
const BOOST_SCHOLARLY_SEARCH = 12.0;
const BOOST_SCHOLARLY_PDF = 10.0;
const BOOST_SCHOLARLY_VENUE_SOURCE = 38.0;
const BOOST_COMPUTE_CONTEXT = 52.0;
const BOOST_SOCIAL_USER_TIMELINE_INTENT = 18.0;
const BOOST_MARXISTS_ARCHIVE_INTENT = 50.0;

const SCHOLARLY_WORKFLOW_COMMANDS = new Set([
  "pdf/read",
  "hf/paper",
  "hf/top",
  "huggingface-papers/search",
  "huggingface-papers/daily",
]);
const SCHOLARLY_NON_BLOCKING_SITE_HINTS = new Set(["agents", "pdf"]);

export function resolveIntentFrame(
  input: IntentKernelInput,
): IntentFrame | undefined {
  const terms = new Set(input.queryTerms);
  const siteHints = new Set(input.siteHints);
  const normalizedQuery = input.query.normalize("NFKC").toLowerCase();

  if (isAudioPlaybackIntent(normalizedQuery, terms, siteHints)) {
    return {
      kind: "audio.playback",
      preferredSites: preferredSites(siteHints, AUDIO_SITES),
    };
  }

  if (isTravelLodgingIntent(terms, siteHints)) {
    return {
      kind: "travel.lodging",
      preferredSites: preferredSites(siteHints, TRAVEL_SITES),
    };
  }

  return undefined;
}

export function evaluateIntentFrame(
  frame: IntentFrame | undefined,
  doc: SearchDocument,
): IntentKernelDecision {
  if (!frame) return { blocked: false, boost: 0 };

  switch (frame.kind) {
    case "audio.playback":
      return evaluateAudioPlayback(frame, doc);
    case "travel.lodging":
      return evaluateTravelLodging(frame, doc);
  }
}

// ── macOS Shortcuts app-action namespace prior ──────────────────────────────
// Auto-generated Shortcuts app-action inventory makes up roughly half of the
// command corpus (1,849 of ~3.6k documents as of 2026-06) under the single
// macos site. Without an authority prior it drowns hand-authored system
// commands on generic intents (screenshot, notifications, wifi). The prior is
// a soft multiplier: it never removes a candidate, and it is disabled when
// the query explicitly asks for Shortcuts actions.

const APP_ACTION_COMMAND_PREFIX = "app-action-";
const APP_ACTION_SCORE_PRIOR = 0.5;
const SHORTCUTS_INTENT_TERMS: ReadonlySet<string> = new Set([
  "shortcuts",
  "shortcut",
  "快捷指令",
  "app-action",
]);

export function appActionScorePrior(
  doc: SearchDocument,
  queryTerms: readonly string[],
): number {
  if (doc.site !== "macos") return 1;
  if (!doc.command.startsWith(APP_ACTION_COMMAND_PREFIX)) return 1;
  for (const term of queryTerms) {
    if (SHORTCUTS_INTENT_TERMS.has(term)) return 1;
  }
  return APP_ACTION_SCORE_PRIOR;
}

export function intentBoost(
  doc: SearchDocument,
  queryTerms: string[],
  siteHints: string[],
): number {
  return (
    architectureIntentBoost(doc, queryTerms) +
    acgCreatorIntentBoost(doc, queryTerms) +
    acgMediaTrendIntentBoost(doc, queryTerms) +
    weatherIntentBoost(doc, queryTerms) +
    computeContextIntentBoost(doc, queryTerms) +
    socialUserTimelineIntentBoost(doc, queryTerms) +
    marxistsArchiveIntentBoost(doc, queryTerms) +
    scholarlyIntentBoost(doc, queryTerms, siteHints)
  );
}

function isAudioPlaybackIntent(
  normalizedQuery: string,
  terms: Set<string>,
  siteHints: Set<string>,
): boolean {
  if (MEDIA_STATUS_TRIGGER.test(normalizedQuery)) return false;
  if (MEDIA_SEARCH_TRIGGER.test(normalizedQuery) && !hasPlaybackVerb(terms)) {
    return false;
  }
  if (NON_AUDIO_PLAY_HINT.test(normalizedQuery)) return false;

  const hasAudioSite = hasAnyValue(siteHints, AUDIO_QUERY_SITE_HINTS);
  const hasAudioTerm = hasAny(terms, [
    "audio",
    "music",
    "song",
    "songs",
    "track",
    "tracks",
    "歌曲",
    "音乐",
  ]);
  const hasPlaybackTrigger = MEDIA_PLAYBACK_TRIGGER.test(normalizedQuery);

  if (hasPlaybackTrigger && (hasAudioSite || hasAudioTerm)) return true;
  if (hasPlaybackTrigger && normalizedQuery.startsWith("play ")) return true;
  return /我想听|想听|听一下|收听|播放|放一下/u.test(normalizedQuery);
}

function hasPlaybackVerb(terms: Set<string>): boolean {
  return hasAny(terms, ["play", "listen", "播放", "收听", "想听"]);
}

function isTravelLodgingIntent(
  terms: Set<string>,
  siteHints: Set<string>,
): boolean {
  return (
    hasAnyValue(siteHints, TRAVEL_SITES) &&
    hasAnyValue(terms, TRAVEL_LODGING_TERMS)
  );
}

function evaluateAudioPlayback(
  frame: Extract<IntentFrame, { kind: "audio.playback" }>,
  doc: SearchDocument,
): IntentKernelDecision {
  const category = documentCategory(doc);
  const preferredSite = frame.preferredSites.includes(doc.site);
  if (!preferredSite && AUDIO_BLOCKED_CATEGORIES.has(category)) {
    return { blocked: true, boost: 0 };
  }

  let boost = 0;
  if (category === "audio") boost += AUDIO_CATEGORY_BOOST;
  if (preferredSite) boost += AUDIO_SITE_HINT_BOOST;
  boost += AUDIO_PLAYBACK_COMMANDS.get(doc.command) ?? 0;
  boost += AUDIO_SECONDARY_PENALTY.get(doc.command) ?? 0;
  return { blocked: false, boost };
}

function evaluateTravelLodging(
  frame: Extract<IntentFrame, { kind: "travel.lodging" }>,
  doc: SearchDocument,
): IntentKernelDecision {
  if (!frame.preferredSites.includes(doc.site)) {
    return { blocked: false, boost: 0 };
  }
  if (doc.command === "hotel-search") {
    return { blocked: false, boost: TRAVEL_LODGING_COMMAND_BOOST };
  }
  if (doc.command === "hotel-suggest") {
    return { blocked: false, boost: TRAVEL_LODGING_COMMAND_BOOST * 0.72 };
  }
  return { blocked: false, boost: 0 };
}

function preferredSites<T extends string>(
  siteHints: Set<string>,
  defaultSites: readonly T[],
): readonly string[] {
  const hinted = defaultSites.filter((site) => siteHints.has(site));
  return hinted.length > 0 ? hinted : defaultSites;
}

function documentCategory(doc: SearchDocument): string {
  return doc.category ?? SITE_CATEGORIES.get(doc.site) ?? "other";
}

function architectureIntentBoost(
  doc: SearchDocument,
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

function computeContextIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  if (doc.site !== "compute") return 0;

  const terms = new Set(queryTerms);
  const localComputerUseIntent =
    hasAny(terms, [
      "computer",
      "desktop",
      "app",
      "apps",
      "window",
      "windows",
      "local",
      "accessibility",
      "ax",
    ]) ||
    (terms.has("app") && terms.has("shots"));
  const evidenceIntent = hasAny(terms, [
    "capture",
    "snapshot",
    "screenshot",
    "reference",
    "refs",
    "shots",
    "appshots",
    "handoff",
    "trajectory",
  ]);
  if (!localComputerUseIntent || !evidenceIntent) return 0;

  if (
    doc.command === "capture" &&
    hasAny(terms, [
      "capture",
      "reference",
      "shots",
      "appshots",
      "handoff",
      "trajectory",
    ])
  ) {
    return BOOST_COMPUTE_CONTEXT;
  }
  if (
    doc.command === "snapshot" &&
    hasAny(terms, ["snapshot", "accessibility", "refs"])
  ) {
    return BOOST_COMPUTE_CONTEXT * 0.72;
  }
  if (doc.command === "screenshot" && terms.has("screenshot")) {
    return BOOST_COMPUTE_CONTEXT * 0.58;
  }
  return BOOST_COMPUTE_CONTEXT * 0.35;
}

function socialUserTimelineIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  const terms = new Set(queryTerms);
  const userTimelineIntent =
    hasAny(terms, ["user", "users", "profile", "author"]) &&
    hasAny(terms, ["timeline", "timelines", "tweets", "posts", "feed"]);
  const userTimelineCommand =
    doc.site === "twitter" &&
    (doc.command === "user-timeline" || doc.command === "user-tweets");

  return userTimelineIntent && userTimelineCommand
    ? BOOST_SOCIAL_USER_TIMELINE_INTENT
    : 0;
}

function marxistsArchiveIntentBoost(
  doc: SearchIndex["documents"][number],
  queryTerms: string[],
): number {
  if (doc.site !== "marxists-cn") return 0;
  const terms = new Set(queryTerms);
  const marxistSubjectIntent = hasAny(terms, [
    "marxism",
    "marxist",
    "marxists",
    "marx",
    "engels",
    "lenin",
    "socialism",
    "communism",
    "dialectics",
    "materialism",
    "western",
    "western-marxism",
    "frankfurt",
    "gramsci",
    "lukacs",
    "korsch",
    "benjamin",
    "adorno",
    "marcuse",
    "althusser",
    "mandel",
  ]);
  const archiveRetrievalIntent = hasAny(terms, [
    "archive",
    "library",
    "reference",
    "philosophy",
    "theory",
    "search",
    "find",
    "query",
    "lookup",
    "retrieve",
    "read",
    "content",
    "text",
    "book",
    "books",
    "work",
    "works",
    "author",
    "authors",
    "people",
    "famous",
    "classic",
    "canonical",
    "canon",
    "reading",
    "list",
    "reading-list",
  ]);
  if (!marxistSubjectIntent || !archiveRetrievalIntent) return 0;

  const westernMarxismIntent = hasAny(terms, [
    "western",
    "western-marxism",
    "frankfurt",
    "gramsci",
    "lukacs",
    "korsch",
    "benjamin",
    "adorno",
    "marcuse",
    "althusser",
    "mandel",
  ]);
  const canonicalReadingIntent = hasAny(terms, [
    "famous",
    "classic",
    "canonical",
    "canon",
    "reading",
    "list",
    "authors",
    "people",
    "works",
    "books",
  ]);
  if (
    westernMarxismIntent &&
    canonicalReadingIntent &&
    doc.command === "western-marxism"
  ) {
    return BOOST_MARXISTS_ARCHIVE_INTENT * 1.18;
  }
  if (
    westernMarxismIntent &&
    canonicalReadingIntent &&
    doc.command === "reading-list"
  ) {
    return BOOST_MARXISTS_ARCHIVE_INTENT * 1.04;
  }
  if (doc.command === "search") return BOOST_MARXISTS_ARCHIVE_INTENT;
  if (
    hasAny(terms, ["author", "authors", "people", "marx", "engels", "lenin"]) &&
    doc.command === "authors"
  ) {
    return BOOST_MARXISTS_ARCHIVE_INTENT * 0.84;
  }
  if (
    hasAny(terms, ["book", "books", "work", "works", "text"]) &&
    doc.command === "works"
  ) {
    return BOOST_MARXISTS_ARCHIVE_INTENT * 0.76;
  }
  if (hasAny(terms, ["read", "content", "text"]) && doc.command === "read") {
    return BOOST_MARXISTS_ARCHIVE_INTENT * 0.7;
  }
  if (doc.command === "index") return BOOST_MARXISTS_ARCHIVE_INTENT * 0.58;
  return 0;
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

function hasAnyValue<T>(
  values: Set<T>,
  needles: ReadonlySet<T> | readonly T[],
): boolean {
  for (const needle of needles) {
    if (values.has(needle)) return true;
  }
  return false;
}
