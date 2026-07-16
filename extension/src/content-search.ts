/**
 * @owner       extension/src/content-search.ts
 * @does        Execute bounded, on-demand search across eligible open-tab DOM text and optional Chrome history metadata without target claims or browser UI mutation.
 * @needs       chrome.tabs/windows/scripting/history/webNavigation, cancellable-operation.ts, src/browser/chrome-native-protocol.ts
 * @feeds       extension/src/chrome-controller.ts
 * @breaks      ChromeContentSearchError on malformed bounds, unavailable history, invalid main-frame results, cancellation, or failed UI postconditions; unreadable tabs remain typed failures and partial secondary-frame reads are marked truncated.
 * @invariants  Search is explicit-request-only, reads a bounded set of main/cross-origin frame worlds through the rendered composed tree, omits aria-hidden and sensitive-control descendants across slot boundaries, preserves a valid main-frame result if secondary frames race away, never attaches the debugger, never focuses/navigates/claims a tab, URL duplicates cannot amplify rank, and results remain fixed-size.
 * @side-effects Runs bounded isolated-world scripts and optionally reads Chrome history; it does not persist page content or search state.
 * @perf        O(T + H + F + C) for bounded selected tabs T, history rows H, frames F, and total scanned text C; four tab scans run concurrently, framed tabs use at most two injections, and output is O(result limit).
 * @concurrency One native command owns the aggregate search; four independent tab reads run concurrently and cancellation reaches every unsettled Chrome promise.
 * @test        tests/unit/extension/content-search.test.ts, tests/integration/browser-extension-background.test.ts, tests/integration/browser-ref-capabilities.test.ts
 * @stability   experimental
 * @since       2026-07-16
 */

import {
  CHROME_CONTENT_SEARCH_DEFAULT_MAX_CHARS_PER_TAB,
  CHROME_CONTENT_SEARCH_DEFAULT_MAX_RESULTS,
  CHROME_CONTENT_SEARCH_DEFAULT_MAX_TABS,
  CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB,
  CHROME_CONTENT_SEARCH_MAX_RESULTS,
  CHROME_CONTENT_SEARCH_MAX_TABS,
  type ChromeContentSearchFailure,
  type ChromeContentSearchMatch,
  type ChromeContentSearchQuery,
  type ChromeContentSearchResult,
} from "../../src/browser/chrome-native-protocol.js";
import { raceWithCancellation } from "./cancellable-operation.js";

const TAB_CONCURRENCY = 4;
const MAX_FRAMES_PER_TAB = 32;
const HISTORY_CANDIDATE_LIMIT = 500;
const FAILURE_OUTPUT_LIMIT = 20;
const TITLE_OUTPUT_LIMIT = 512;
const URL_OUTPUT_LIMIT = 4_096;
const SNIPPET_OUTPUT_LIMIT = 320;

interface ChromeContentSearchUiBoundary<T> {
  capture(): Promise<T>;
  assertUnchanged(before: T, action: string): Promise<void>;
}

interface NormalizedSearchQuery {
  query: string;
  queryLower: string;
  terms: string[];
  includeHistory: boolean;
  maxResults: number;
  maxTabs: number;
  maxCharsPerTab: number;
  historyStartTime?: number;
  historyEndTime?: number;
}

interface SearchableTab extends chrome.tabs.Tab {
  id: number;
  windowId: number;
  url: string;
}

interface PageSearchInput {
  query_lower: string;
  terms: string[];
  max_chars: number;
}

export interface PageSearchResult {
  scanned_chars: number;
  scanned_nodes: number;
  truncated: boolean;
  exact_query_match: boolean;
  matched_terms: number;
  matched_term_indexes: number[];
  match_count: number;
  snippets: string[];
}

type TabSearchOutcome =
  | { ok: true; match: ChromeContentSearchMatch | null; truncated: boolean }
  | { ok: false; failure: ChromeContentSearchFailure };

export class ChromeContentSearchError extends Error {
  readonly retryable = false;
  readonly outcomeAmbiguous = false;

  constructor(
    readonly code: string,
    message: string,
    readonly suggestion: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChromeContentSearchError";
  }
}

export async function searchChromeContent<T>(
  rawQuery: ChromeContentSearchQuery,
  ui: ChromeContentSearchUiBoundary<T>,
  signal?: AbortSignal,
): Promise<ChromeContentSearchResult> {
  const query = normalizeSearchQuery(rawQuery);
  signal?.throwIfAborted();
  const before = await ui.capture();
  signal?.throwIfAborted();
  const [windows, tabs] = await Promise.all([
    raceWithCancellation(
      () => chrome.windows.getAll({ windowTypes: ["normal"] }),
      signal,
    ),
    raceWithCancellation(() => chrome.tabs.query({}), signal),
  ]);
  const normalWindowIds = new Set(
    windows
      .map((window) => window.id)
      .filter((id): id is number => typeof id === "number"),
  );
  const eligibleTabs = tabs
    .filter(
      (tab): tab is SearchableTab =>
        typeof tab.id === "number" &&
        typeof tab.windowId === "number" &&
        typeof tab.url === "string" &&
        normalWindowIds.has(tab.windowId) &&
        /^https?:/i.test(tab.url),
    )
    .sort(
      (left, right) =>
        (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0) ||
        left.id - right.id,
    );
  const selectedTabs = eligibleTabs.slice(0, query.maxTabs);
  const [tabOutcomes, historyItems] = await Promise.all([
    mapWithConcurrency(
      selectedTabs,
      TAB_CONCURRENCY,
      (tab) => searchOpenTab(tab, query, signal),
      signal,
    ),
    query.includeHistory ? searchHistory(query, signal) : Promise.resolve([]),
  ]);
  signal?.throwIfAborted();
  await ui.assertUnchanged(before, "content.search");
  signal?.throwIfAborted();

  const openTabMatches = tabOutcomes.flatMap((outcome) =>
    outcome.ok && outcome.match ? [outcome.match] : [],
  );
  const historyMatches = historyItems.flatMap((item) => {
    const match = historyItemToMatch(item, query);
    return match ? [match] : [];
  });
  const ranked = mergeAndRankMatches([...openTabMatches, ...historyMatches]);
  const failures = tabOutcomes.flatMap((outcome) =>
    outcome.ok ? [] : [outcome.failure],
  );
  const results = ranked.slice(0, query.maxResults);
  return {
    query: query.query,
    result_count: results.length,
    eligible_open_tabs: eligibleTabs.length,
    scanned_open_tabs: tabOutcomes.length,
    matched_open_tabs: openTabMatches.length,
    failed_open_tabs: failures.length,
    scanned_history_items: historyItems.length,
    matched_history_items: historyMatches.length,
    ui_state_unchanged: true,
    truncated:
      eligibleTabs.length > selectedTabs.length ||
      ranked.length > results.length ||
      historyItems.length === historyCandidateLimit(query.maxResults) ||
      tabOutcomes.some((outcome) => outcome.ok && outcome.truncated),
    limits: {
      max_results: query.maxResults,
      max_tabs: query.maxTabs,
      max_chars_per_tab: query.maxCharsPerTab,
      tab_concurrency: TAB_CONCURRENCY,
      max_frames_per_tab: MAX_FRAMES_PER_TAB,
    },
    results,
    failures: failures.slice(0, FAILURE_OUTPUT_LIMIT),
  };
}

async function searchOpenTab(
  tab: SearchableTab,
  query: NormalizedSearchQuery,
  signal?: AbortSignal,
): Promise<TabSearchOutcome> {
  try {
    if (!chrome.scripting?.executeScript) {
      throw new ChromeContentSearchError(
        "chrome_content_search_unavailable",
        "chrome.scripting.executeScript is unavailable",
        "Reload the Uni-CLI extension with scripting and host permissions enabled.",
      );
    }
    const frames = await readSearchableFrames(tab.id, signal);
    const frameCharacterBudget = Math.max(
      1,
      Math.floor(query.maxCharsPerTab / frames.frameIds.length),
    );
    const executeFrames = (frameIds: number[]) =>
      raceWithCancellation(
        () =>
          chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds },
            world: "ISOLATED",
            func: searchOpenDocument,
            args: [
              {
                query_lower: query.queryLower,
                terms: query.terms,
                max_chars: frameCharacterBudget,
              } satisfies PageSearchInput,
            ],
          }),
        signal,
      );
    const mainFrame = await executeFrames([0]);
    let secondaryFrames: chrome.scripting.InjectionResult<unknown>[] = [];
    let unreadableSecondaryFrames = false;
    if (frames.frameIds.length > 1) {
      try {
        secondaryFrames = await executeFrames(frames.frameIds.slice(1));
      } catch {
        if (signal?.aborted) throw signal.reason;
        unreadableSecondaryFrames = true;
      }
    }
    const injection = [...mainFrame, ...secondaryFrames];
    signal?.throwIfAborted();
    if (injection.length === 0) throw invalidPageResult();
    const page = mergePageSearchResults(
      injection.map((entry) =>
        readPageSearchResult(
          entry.result,
          frameCharacterBudget,
          query.terms.length,
        ),
      ),
      frames.truncated ||
        unreadableSecondaryFrames ||
        injection.length < frames.frameIds.length,
      query.maxCharsPerTab,
    );
    return {
      ok: true,
      match: tabToMatch(tab, page, query),
      truncated: page.truncated,
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return {
      ok: false,
      failure: {
        source: "open_tab",
        tab_id: tab.id,
        url: bounded(tab.url, URL_OUTPUT_LIMIT),
        code: readErrorCode(error),
        message: bounded(errorMessage(error), 512),
      },
    };
  }
}

async function searchHistory(
  query: NormalizedSearchQuery,
  signal?: AbortSignal,
): Promise<chrome.history.HistoryItem[]> {
  if (!chrome.history?.search) {
    throw new ChromeContentSearchError(
      "chrome_history_unavailable",
      "Chrome history search is unavailable",
      "Install or re-enable the Uni-CLI extension with the history permission, or omit --history.",
    );
  }
  return raceWithCancellation(
    () =>
      chrome.history.search({
        text: query.query,
        startTime: query.historyStartTime ?? 0,
        ...(query.historyEndTime === undefined
          ? {}
          : { endTime: query.historyEndTime }),
        maxResults: historyCandidateLimit(query.maxResults),
      }),
    signal,
  );
}

function tabToMatch(
  tab: SearchableTab,
  page: PageSearchResult,
  query: NormalizedSearchQuery,
): ChromeContentSearchMatch | null {
  const title = bounded(tab.title ?? "", TITLE_OUTPUT_LIMIT);
  const url = bounded(tab.url, URL_OUTPUT_LIMIT);
  const titleScore = metadataScore(title, query, 120, 18);
  const urlScore = metadataScore(url, query, 90, 12);
  const contentScore =
    page.match_count === 0
      ? 0
      : (page.exact_query_match ? 80 : 35) +
        page.matched_terms * 10 +
        Math.min(page.match_count, 10);
  if (titleScore + urlScore + contentScore === 0) return null;
  const matchFields: ChromeContentSearchMatch["match_fields"] = [];
  if (titleScore > 0) matchFields.push("title");
  if (urlScore > 0) matchFields.push("url");
  if (contentScore > 0) matchFields.push("content");
  return {
    sources: ["open_tab"],
    url,
    ...(title ? { title } : {}),
    score: titleScore + urlScore + contentScore,
    match_fields: matchFields,
    ...(page.snippets.length > 0 ? { snippets: page.snippets } : {}),
    tab_id: tab.id,
    window_id: tab.windowId,
    active: tab.active === true,
    ...(typeof tab.lastAccessed === "number"
      ? { last_accessed: tab.lastAccessed }
      : {}),
  };
}

function historyItemToMatch(
  item: chrome.history.HistoryItem,
  query: NormalizedSearchQuery,
): ChromeContentSearchMatch | null {
  const url = bounded(item.url ?? "", URL_OUTPUT_LIMIT);
  if (!/^https?:/i.test(url)) return null;
  const title = bounded(item.title ?? "", TITLE_OUTPUT_LIMIT);
  const titleScore = metadataScore(title, query, 100, 15);
  const urlScore = metadataScore(url, query, 75, 10);
  if (titleScore + urlScore === 0) return null;
  const matchFields: ChromeContentSearchMatch["match_fields"] = [];
  if (titleScore > 0) matchFields.push("title");
  if (urlScore > 0) matchFields.push("url");
  return {
    sources: ["history"],
    url,
    ...(title ? { title } : {}),
    score: titleScore + urlScore,
    match_fields: matchFields,
    ...(typeof item.lastVisitTime === "number"
      ? { last_visit_time: item.lastVisitTime }
      : {}),
    ...(typeof item.visitCount === "number"
      ? { visit_count: item.visitCount }
      : {}),
  };
}

function mergeAndRankMatches(
  matches: ChromeContentSearchMatch[],
): ChromeContentSearchMatch[] {
  const byUrl = new Map<string, ChromeContentSearchMatch>();
  for (const match of matches) {
    const existing = byUrl.get(match.url);
    if (!existing) {
      byUrl.set(match.url, match);
      continue;
    }
    byUrl.set(match.url, mergeMatch(existing, match));
  }
  return [...byUrl.values()].sort(
    (left, right) =>
      right.score - left.score ||
      (right.last_accessed ?? right.last_visit_time ?? 0) -
        (left.last_accessed ?? left.last_visit_time ?? 0) ||
      compareStrings(left.url, right.url),
  );
}

function mergeMatch(
  left: ChromeContentSearchMatch,
  right: ChromeContentSearchMatch,
): ChromeContentSearchMatch {
  const sourceOrder: ChromeContentSearchMatch["sources"] = [
    "open_tab",
    "history",
  ];
  const fieldOrder: ChromeContentSearchMatch["match_fields"] = [
    "title",
    "url",
    "content",
  ];
  const sources = sourceOrder.filter(
    (source) => left.sources.includes(source) || right.sources.includes(source),
  );
  const matchFields = fieldOrder.filter(
    (field) =>
      left.match_fields.includes(field) || right.match_fields.includes(field),
  );
  const snippets = [...(left.snippets ?? []), ...(right.snippets ?? [])].filter(
    (snippet, index, all) => all.indexOf(snippet) === index,
  );
  const lastVisitTime = left.last_visit_time ?? right.last_visit_time;
  const visitCount = left.visit_count ?? right.visit_count;
  const addsIndependentSource =
    left.sources.some((source) => !right.sources.includes(source)) ||
    right.sources.some((source) => !left.sources.includes(source));
  return {
    ...right,
    ...left,
    sources,
    score: addsIndependentSource
      ? left.score + right.score
      : Math.max(left.score, right.score),
    match_fields: matchFields,
    ...(snippets.length > 0 ? { snippets: snippets.slice(0, 3) } : {}),
    ...(lastVisitTime === undefined ? {} : { last_visit_time: lastVisitTime }),
    ...(visitCount === undefined ? {} : { visit_count: visitCount }),
  };
}

function metadataScore(
  value: string,
  query: NormalizedSearchQuery,
  exactWeight: number,
  termWeight: number,
): number {
  if (!value) return 0;
  const normalized = value.toLowerCase();
  const exact = normalized.includes(query.queryLower);
  const termMatches = query.terms.reduce(
    (count, term) => count + (normalized.includes(term) ? 1 : 0),
    0,
  );
  return (exact ? exactWeight : 0) + termMatches * termWeight;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
  return results;
}

function normalizeSearchQuery(
  raw: ChromeContentSearchQuery,
): NormalizedSearchQuery {
  const query = raw.query?.trim();
  if (!query || query.length > 512) {
    throw invalidSearch("query must contain 1 to 512 characters");
  }
  const includeHistory = raw.include_history === true;
  if (
    !includeHistory &&
    (raw.history_start_time !== undefined || raw.history_end_time !== undefined)
  ) {
    throw invalidSearch("history bounds require include_history=true");
  }
  const historyStartTime = optionalTimestamp(
    raw.history_start_time,
    "history_start_time",
  );
  const historyEndTime = optionalTimestamp(
    raw.history_end_time,
    "history_end_time",
  );
  if (
    historyStartTime !== undefined &&
    historyEndTime !== undefined &&
    historyStartTime > historyEndTime
  ) {
    throw invalidSearch("history_start_time must not exceed history_end_time");
  }
  const queryLower = query.toLowerCase();
  const terms = [
    ...new Set(
      queryLower
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((term) => term.trim())
        .filter(Boolean)
        .slice(0, 16),
    ),
  ];
  return {
    query,
    queryLower,
    terms: terms.length > 0 ? terms : [queryLower],
    includeHistory,
    maxResults: boundedInteger(
      raw.max_results,
      CHROME_CONTENT_SEARCH_DEFAULT_MAX_RESULTS,
      1,
      CHROME_CONTENT_SEARCH_MAX_RESULTS,
      "max_results",
    ),
    maxTabs: boundedInteger(
      raw.max_tabs,
      CHROME_CONTENT_SEARCH_DEFAULT_MAX_TABS,
      1,
      CHROME_CONTENT_SEARCH_MAX_TABS,
      "max_tabs",
    ),
    maxCharsPerTab: boundedInteger(
      raw.max_chars_per_tab,
      CHROME_CONTENT_SEARCH_DEFAULT_MAX_CHARS_PER_TAB,
      1_024,
      CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB,
      "max_chars_per_tab",
    ),
    ...(historyStartTime === undefined ? {} : { historyStartTime }),
    ...(historyEndTime === undefined ? {} : { historyEndTime }),
  };
}

function readPageSearchResult(
  value: unknown,
  maxCharacters: number,
  termCount: number,
): PageSearchResult {
  if (!isRecord(value)) throw invalidPageResult();
  const snippets = value.snippets;
  const matchedTermIndexes = value.matched_term_indexes;
  if (
    !boundedIntegerValue(value.scanned_chars, maxCharacters) ||
    !boundedIntegerValue(value.scanned_nodes, 50_000) ||
    typeof value.truncated !== "boolean" ||
    typeof value.exact_query_match !== "boolean" ||
    !boundedIntegerValue(value.matched_terms, termCount) ||
    !Array.isArray(matchedTermIndexes) ||
    matchedTermIndexes.length !== value.matched_terms ||
    new Set(matchedTermIndexes).size !== matchedTermIndexes.length ||
    !matchedTermIndexes.every((index) =>
      boundedIntegerValue(index, Math.max(0, termCount - 1)),
    ) ||
    !boundedIntegerValue(value.match_count, (termCount + 1) * 3) ||
    !Array.isArray(snippets) ||
    snippets.length > 3 ||
    !snippets.every(
      (snippet) =>
        typeof snippet === "string" && snippet.length <= SNIPPET_OUTPUT_LIMIT,
    )
  ) {
    throw invalidPageResult();
  }
  return value as unknown as PageSearchResult;
}

async function readSearchableFrames(
  tabId: number,
  signal?: AbortSignal,
): Promise<{ frameIds: number[]; truncated: boolean }> {
  if (!chrome.webNavigation?.getAllFrames) {
    throw new ChromeContentSearchError(
      "chrome_content_search_unavailable",
      "chrome.webNavigation.getAllFrames is unavailable",
      "Reload the Uni-CLI extension with webNavigation permission enabled.",
    );
  }
  const frames = await raceWithCancellation(
    () => chrome.webNavigation.getAllFrames({ tabId }),
    signal,
  );
  const frameIds = [
    ...new Set(
      (frames ?? [])
        .map((frame) => frame.frameId)
        .filter((frameId) => nonnegativeInteger(frameId)),
    ),
  ].sort((left, right) => left - right);
  if (frameIds.length === 0) {
    throw new ChromeContentSearchError(
      "chrome_tab_content_unavailable",
      `Chrome tab ${String(tabId)} has no inspectable document frames`,
      "Wait for the page to finish loading and retry the bounded search.",
    );
  }
  return {
    frameIds: frameIds.slice(0, MAX_FRAMES_PER_TAB),
    truncated: frameIds.length > MAX_FRAMES_PER_TAB,
  };
}

function mergePageSearchResults(
  pages: readonly PageSearchResult[],
  frameTruncated: boolean,
  maxCharacters: number,
): PageSearchResult {
  const termIndexes = new Set<number>();
  const snippets = new Set<string>();
  let scannedCharacters = 0;
  let scannedNodes = 0;
  let matchCount = 0;
  let truncated = frameTruncated;
  let exactQueryMatch = false;
  for (const page of pages) {
    scannedCharacters += page.scanned_chars;
    scannedNodes += page.scanned_nodes;
    matchCount += page.match_count;
    truncated ||= page.truncated;
    exactQueryMatch ||= page.exact_query_match;
    for (const index of page.matched_term_indexes) termIndexes.add(index);
    for (const snippet of page.snippets) snippets.add(snippet);
  }
  return {
    scanned_chars: Math.min(scannedCharacters, maxCharacters),
    scanned_nodes: scannedNodes,
    truncated,
    exact_query_match: exactQueryMatch,
    matched_terms: termIndexes.size,
    matched_term_indexes: [...termIndexes].sort((left, right) => left - right),
    match_count: matchCount,
    snippets: [...snippets].slice(0, 3),
  };
}

function invalidPageResult(): ChromeContentSearchError {
  return new ChromeContentSearchError(
    "chrome_content_search_invalid",
    "Chrome page search returned an invalid bounded result",
    "Reload the Uni-CLI extension and retry the explicit search.",
  );
}

function invalidSearch(message: string): ChromeContentSearchError {
  return new ChromeContentSearchError(
    "chrome_content_search_invalid",
    `Invalid Chrome content search: ${message}`,
    "Use a non-empty query and keep every search bound within the documented limits.",
  );
}

function optionalTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidSearch(
      `${name} must be a nonnegative epoch-millisecond value`,
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidSearch(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function historyCandidateLimit(maxResults: number): number {
  return Math.min(HISTORY_CANDIDATE_LIMIT, maxResults * 5);
}

function bounded(value: string, limit: number): string {
  return value.slice(0, limit);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "chrome_tab_content_unavailable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedIntegerValue(value: unknown, maximum: number): value is number {
  return nonnegativeInteger(value) && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function searchOpenDocument(input: PageSearchInput): PageSearchResult {
  const sensitiveAutocompleteTokens = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
  ]);
  const isSensitiveControl = (element: Element): boolean => {
    if (!/^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName)) return false;
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (type === "password" || type === "hidden") return true;
    return (element.getAttribute("autocomplete") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .some((token) => sensitiveAutocompleteTokens.has(token));
  };
  const maxNodes = Math.min(50_000, Math.max(2_000, input.max_chars >> 2));
  const root = document.body ?? document.documentElement;
  if (!root) {
    return {
      scanned_chars: 0,
      scanned_nodes: 0,
      truncated: false,
      exact_query_match: false,
      matched_terms: 0,
      matched_term_indexes: [],
      match_count: 0,
      snippets: [],
    };
  }
  const chunks: string[] = [];
  const stack: Node[] = [root];
  let chars = 0;
  let nodes = 0;
  let truncated = false;
  while (stack.length > 0 && nodes < maxNodes && chars < input.max_chars) {
    const node = stack.pop()!;
    nodes += 1;
    if (node.nodeType === 3) {
      const text = (node.nodeValue ?? "").replace(/\s+/g, " ").trim();
      if (text) {
        const remaining = input.max_chars - chars;
        const selected = text.slice(0, remaining);
        chunks.push(selected);
        chars += selected.length + 1;
        if (selected.length < text.length) truncated = true;
      }
      continue;
    }
    let childNodes: ArrayLike<Node> = node.childNodes;
    if (node.nodeType === 1) {
      const element = node as Element;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/i.test(element.tagName)) continue;
      if (element.getAttribute("aria-hidden")?.toLowerCase() === "true") {
        continue;
      }
      if (isSensitiveControl(element)) continue;
      if (
        element.tagName === "SLOT" &&
        typeof (element as HTMLSlotElement).assignedNodes === "function"
      ) {
        const assigned = (element as HTMLSlotElement).assignedNodes({
          flatten: true,
        });
        childNodes = assigned.length > 0 ? assigned : element.childNodes;
      } else if (element.shadowRoot) {
        childNodes = element.shadowRoot.childNodes;
      }
    }
    for (let index = childNodes.length - 1; index >= 0; index -= 1) {
      stack.push(childNodes[index]!);
    }
  }
  if (stack.length > 0 || nodes >= maxNodes || chars >= input.max_chars) {
    truncated = true;
  }
  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  const normalized = text.toLowerCase();
  const needles = [input.query_lower, ...input.terms].filter(
    (needle, index, all) => needle && all.indexOf(needle) === index,
  );
  const positions: number[] = [];
  let matchCount = 0;
  for (const needle of needles) {
    let offset = 0;
    for (let count = 0; count < 3; count += 1) {
      const position = normalized.indexOf(needle, offset);
      if (position < 0) break;
      matchCount += 1;
      positions.push(position);
      offset = position + Math.max(1, needle.length);
    }
  }
  positions.sort((left, right) => left - right);
  const snippets = positions
    .filter((position, index, all) => all.indexOf(position) === index)
    .slice(0, 3)
    .map((position) => {
      const start = Math.max(0, position - 120);
      const end = Math.min(text.length, position + 200);
      return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`.slice(
        0,
        320,
      );
    });
  const matchedTermIndexes = input.terms.flatMap((term, index) =>
    normalized.includes(term) ? [index] : [],
  );
  return {
    scanned_chars: Math.min(text.length, input.max_chars),
    scanned_nodes: nodes,
    truncated,
    exact_query_match: normalized.includes(input.query_lower),
    matched_terms: matchedTermIndexes.length,
    matched_term_indexes: matchedTermIndexes,
    match_count: matchCount,
    snippets,
  };
}
