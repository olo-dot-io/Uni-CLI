/**
 * Twitter GraphQL client — authenticated API access via browser cookies.
 *
 * Uses the public GraphQL endpoint at x.com with cookie-based authentication.
 * Requires ct0 (CSRF token) and auth_token cookies in ~/.unicli/cookies/twitter.json
 */

import {
  loadCookiesWithCDP,
  formatCookieHeader,
} from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveOperation } from "./operations.js";

// Public bearer token — same for all Twitter web clients, not a secret
const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const GRAPHQL_BASE = "https://x.com/i/api/graphql";

function throwTwitterApiError(
  label: string,
  status: number,
  preview: string,
  headers?: Headers,
): never {
  const err = new Error(
    `Twitter API error: HTTP ${status} on ${label}\n${preview.slice(0, 200)}`,
  ) as Error & {
    code?: string;
    suggestion?: string;
    retryable?: boolean;
    alternatives?: string[];
    rateLimitResetMs?: number;
  };
  err.code =
    status === 401 || status === 403
      ? "auth_required"
      : status === 404
        ? "upstream_error"
        : status === 429
          ? "rate_limited"
          : status >= 500
            ? "upstream_error"
            : "api_error";
  err.retryable = status === 429 || status >= 500;
  const reset = Number(headers?.get("x-rate-limit-reset"));
  if (status === 429 && reset > 0) err.rateLimitResetMs = reset * 1000;
  err.suggestion =
    status === 404
      ? "Twitter/X changed or removed this web API operation. Run `unicli repair twitter <command>` or use a browser-backed command while the GraphQL operation is refreshed."
      : status === 401 || status === 403
        ? "Refresh X login state with `unicli --auth-retry twitter <command> --args-file <path.json>`, or open https://x.com in Chrome and sign in."
        : status === 429
          ? "Twitter/X rate-limited the request. Wait, reduce limit, then retry."
          : "Twitter/X API returned an upstream error. Retry once; if it persists, run `unicli repair twitter <command>`.";
  err.alternatives = [
    "unicli auth import twitter --domain x.com",
    "unicli browser open https://x.com",
  ];
  throw err;
}

export function invalidTwitterInput(
  message: string,
  suggestion: string,
): Error {
  return Object.assign(new Error(message), {
    code: "invalid_input",
    retryable: false,
    suggestion,
  });
}

/** Reads a nested JSON object field, giving `{}` for anything that is not an object. */
export function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Standard Twitter GraphQL feature flags */
export const FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_featuring: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// Ids resolved or features learned in this process, so later pages skip the failed first attempt.
const resolvedQueryIds = new Map<string, string>();
const learnedFeatures = new Map<string, Record<string, boolean>>();
const MAX_FEATURE_RETRIES = 2;

/** Feature names from X's 400 answer "The following features cannot be null: a, b". */
function missingFeatures(body: string): string[] {
  const names = /features cannot be null:\s*([\w\s,]+)/.exec(body)?.[1] ?? "";
  return names.split(/[\s,]+/).filter(Boolean);
}

/**
 * Authenticated GraphQL request. An empty `queryId` or an HTTP 404 resolves the
 * current id from the web client (`resolveOperation`) and retries once; a 400
 * naming missing features retries with those features set to true.
 */
async function graphqlRequest(
  method: "GET" | "POST",
  endpoint: string,
  queryId: string,
  variables: Record<string, unknown>,
  features: Record<string, boolean>,
): Promise<unknown> {
  const cookies = await loadCookiesWithCDP("twitter", "x.com");
  if (!cookies) {
    throw new Error(
      'No cookies found for "twitter". Run: unicli auth setup twitter',
    );
  }

  const ct0 = cookies.ct0;
  if (!ct0) {
    throw new Error(
      "Missing ct0 cookie (CSRF token). " +
        "Ensure ~/.unicli/cookies/twitter.json contains ct0 and auth_token.",
    );
  }

  let id = resolvedQueryIds.get(endpoint) ?? queryId;
  let resolved = false;
  if (!id) {
    id = await resolveOperation(endpoint);
    resolved = true;
    resolvedQueryIds.set(endpoint, id);
  }
  let featureSet = { ...features, ...learnedFeatures.get(endpoint) };

  for (let featureRetries = 0; ;) {
    const query =
      method === "GET"
        ? `?${new URLSearchParams({
            variables: JSON.stringify(variables),
            features: JSON.stringify(featureSet),
          }).toString()}`
        : "";
    const resp = await fetch(`${GRAPHQL_BASE}/${id}/${endpoint}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${BEARER_TOKEN}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "User-Agent": USER_AGENT,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        Cookie: formatCookieHeader(cookies),
      },
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              variables,
              features: featureSet,
              queryId: id,
            }),
          }
        : {}),
    });
    if (resp.ok) return resp.json();

    const preview = await resp.text().catch(() => "");
    // X answers 404 for a retired query id before running the operation, so the retry repeats no side effect.
    if (resp.status === 404 && !resolved) {
      resolved = true;
      let current: string;
      try {
        current = await resolveOperation(endpoint);
      } catch (error) {
        throwTwitterApiError(
          endpoint,
          404,
          `${preview}\noperation lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (current !== id) {
        id = current;
        resolvedQueryIds.set(endpoint, id);
        continue;
      }
    }
    const missing = resp.status === 400 ? missingFeatures(preview) : [];
    if (missing.length > 0 && featureRetries < MAX_FEATURE_RETRIES) {
      featureRetries += 1;
      const added = Object.fromEntries(missing.map((name) => [name, true]));
      learnedFeatures.set(endpoint, {
        ...learnedFeatures.get(endpoint),
        ...added,
      });
      featureSet = { ...featureSet, ...added };
      continue;
    }
    throwTwitterApiError(endpoint, resp.status, preview, resp.headers);
  }
}

/**
 * Make an authenticated GraphQL GET request to the Twitter API.
 *
 * @param endpoint - GraphQL operation name (e.g. "SearchTimeline")
 * @param queryId - GraphQL query ID, or "" to resolve the current one
 * @param variables - GraphQL variables object
 * @param features - GraphQL feature flags (defaults to FEATURES)
 * @returns Parsed JSON response
 */
export async function twitterFetch(
  endpoint: string,
  queryId: string,
  variables: Record<string, unknown>,
  features: Record<string, boolean> = FEATURES,
): Promise<unknown> {
  return graphqlRequest("GET", endpoint, queryId, variables, features);
}

/**
 * Make an authenticated GraphQL POST request (for mutations).
 */
export async function twitterPostFetch(
  endpoint: string,
  queryId: string,
  variables: Record<string, unknown>,
  features: Record<string, boolean> = FEATURES,
): Promise<unknown> {
  return graphqlRequest("POST", endpoint, queryId, variables, features);
}

/**
 * Make an authenticated REST API request to the Twitter v1.1 API.
 *
 * @param path - API path (e.g. "/1.1/users/show.json")
 * @param params - URL query parameters
 * @returns Parsed JSON response
 */
export async function twitterRestFetch(
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const cookies = await loadCookiesWithCDP("twitter", "x.com");
  if (!cookies) {
    throw new Error(
      'No cookies found for "twitter". Run: unicli auth setup twitter',
    );
  }

  const ct0 = cookies.ct0;
  if (!ct0) {
    throw new Error(
      "Missing ct0 cookie (CSRF token). " +
        "Ensure ~/.unicli/cookies/twitter.json contains ct0 and auth_token.",
    );
  }

  const searchParams = new URLSearchParams(params);
  const url = `https://x.com${path}?${searchParams.toString()}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
      "User-Agent": USER_AGENT,
      Cookie: formatCookieHeader(cookies),
    },
  });

  if (!resp.ok) {
    const preview = await resp.text().catch(() => "");
    throwTwitterApiError(path, resp.status, preview);
  }

  return resp.json();
}

/**
 * Make an authenticated request to the Twitter v2 guide API.
 *
 * @param url - Full API URL
 * @param params - URL query parameters
 * @returns Parsed JSON response
 */
export async function twitterGuideFetch(
  url: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const cookies = await loadCookiesWithCDP("twitter", "x.com");
  if (!cookies) {
    throw new Error(
      'No cookies found for "twitter". Run: unicli auth setup twitter',
    );
  }

  const ct0 = cookies.ct0;
  if (!ct0) {
    throw new Error(
      "Missing ct0 cookie (CSRF token). " +
        "Ensure ~/.unicli/cookies/twitter.json contains ct0 and auth_token.",
    );
  }

  const searchParams = new URLSearchParams(params);
  const fullUrl = `${url}?${searchParams.toString()}`;

  const resp = await fetch(fullUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
      "X-Csrf-Token": ct0,
      "X-Twitter-Auth-Type": "OAuth2Session",
      "X-Twitter-Active-User": "yes",
      "User-Agent": USER_AGENT,
      Cookie: formatCookieHeader(cookies),
    },
  });

  if (!resp.ok) {
    const preview = await resp.text().catch(() => "");
    throwTwitterApiError("guide", resp.status, preview);
  }

  return resp.json();
}

interface TweetData {
  id: string;
  author: string;
  text: string;
  created_at: string;
  likes: number;
  retweets: number;
  views: number;
  url: string;
}

/**
 * Extract tweet data from a GraphQL tweet result object.
 *
 * Handles both regular tweets and tweets with visibility results.
 * Returns null if the result is not a valid tweet.
 */
export function extractTweet(
  result: Record<string, unknown>,
): TweetData | null {
  // Handle tweet_with_visibility_results wrapper
  let tweetResult = result;
  if (result.tweet) {
    tweetResult = result.tweet as Record<string, unknown>;
  }

  const typename = tweetResult.__typename as string | undefined;
  if (typename !== "Tweet" && typename !== "TweetWithVisibilityResults") {
    return null;
  }

  const restId = tweetResult.rest_id as string | undefined;
  if (!restId) return null;

  // X moved screen_name from user.legacy to user.core in 2026.
  const userResult = obj(obj(obj(tweetResult.core).user_results).result);
  const screenName =
    (obj(userResult.core).screen_name as string | undefined) ??
    (obj(userResult.legacy).screen_name as string | undefined) ??
    "unknown";

  const legacy = tweetResult.legacy as Record<string, unknown> | undefined;
  const fullText = (legacy?.full_text as string) ?? "";
  const favoriteCount = (legacy?.favorite_count as number) ?? 0;
  const retweetCount = (legacy?.retweet_count as number) ?? 0;

  const views = tweetResult.views as Record<string, unknown> | undefined;
  const viewCount = Number((views?.count as string) ?? 0);
  const created = legacy?.created_at as string | undefined;

  return {
    id: restId,
    author: screenName,
    text: fullText,
    created_at: created ? new Date(created).toISOString() : "",
    likes: favoriteCount,
    retweets: retweetCount,
    views: viewCount,
    url: `https://x.com/${screenName}/status/${restId}`,
  };
}

function itemTweet(itemContent: unknown): TweetData | null {
  const item = obj(itemContent);
  if (item.itemType !== "TimelineTweet" || item.promotedMetadata) return null;
  const result = obj(item.tweet_results).result;
  return result ? extractTweet(obj(result)) : null;
}

/**
 * Tweets of each `TimelineAddEntries` entry, promoted posts excluded. A
 * conversation module yields its thread, which can include older parents.
 */
function entryTweets(instructions: unknown[]): TweetData[][] {
  const entries: TweetData[][] = [];
  for (const instruction of instructions) {
    const inst = obj(instruction);
    if (inst.type !== "TimelineAddEntries") continue;
    for (const entry of (inst.entries as unknown[]) ?? []) {
      const content = obj(obj(entry).content);
      const items =
        content.entryType === "TimelineTimelineModule"
          ? ((content.items as unknown[]) ?? []).map(
              (item) => obj(obj(item).item).itemContent,
            )
          : [content.itemContent];
      const tweets = items
        .map(itemTweet)
        .filter((tweet): tweet is TweetData => tweet !== null);
      if (tweets.length > 0) entries.push(tweets);
    }
  }
  return entries;
}

/**
 * Extract tweets from timeline instructions (common pattern for search, home, bookmarks).
 *
 * Timeline instructions contain entries with tweet results nested inside.
 */
export function extractTweetsFromInstructions(
  instructions: unknown[],
): TweetData[] {
  return entryTweets(instructions).flat();
}

interface UserData {
  id: string;
  name: string;
  screen_name: string;
  followers: number;
  following: number;
  description: string;
}

export const USER_COLUMNS = [
  "id",
  "name",
  "screen_name",
  "followers",
  "following",
  "description",
];

/**
 * Extract user entries from timeline instructions (followers/following endpoints).
 */
export function extractUsersFromInstructions(
  instructions: unknown[],
): UserData[] {
  const users: UserData[] = [];

  for (const instruction of instructions) {
    const inst = obj(instruction);
    if (inst.type !== "TimelineAddEntries") continue;
    for (const entry of (inst.entries as unknown[]) ?? []) {
      const itemContent = obj(obj(obj(entry).content).itemContent);
      if (itemContent.itemType !== "TimelineUser") continue;
      const result = obj(obj(itemContent.user_results).result);
      if (typeof result.rest_id !== "string") continue;

      // X moved names, counts and bio out of user.legacy in 2026; legacy covers older shapes.
      const core = obj(result.core);
      const counts = obj(result.relationship_counts);
      const legacy = obj(result.legacy);
      users.push({
        id: result.rest_id,
        name: String(core.name ?? legacy.name ?? ""),
        screen_name: String(core.screen_name ?? legacy.screen_name ?? ""),
        followers: Number(counts.followers ?? legacy.followers_count ?? 0),
        following: Number(counts.following ?? legacy.friends_count ?? 0),
        description: String(
          obj(result.profile_bio).description ?? legacy.description ?? "",
        ),
      });
    }
  }

  return users;
}

function bottomCursor(instructions: unknown[]): string | undefined {
  for (const instruction of instructions) {
    const inst = obj(instruction);
    const entries = Array.isArray(inst.entries)
      ? inst.entries
      : inst.entry
        ? [inst.entry]
        : [];
    for (const entry of entries) {
      const content = obj(obj(entry).content);
      if (content.cursorType === "Bottom" && typeof content.value === "string")
        return content.value;
    }
  }
  return undefined;
}

/**
 * Instructions of each page of a cursor-paginated GraphQL timeline found at
 * `path` in the response. Ends when X returns no new bottom cursor.
 */
export async function* timelinePages(
  endpoint: string,
  queryId: string,
  variables: Record<string, unknown>,
  path: string[],
): AsyncGenerator<unknown[]> {
  let cursor: string | undefined;
  for (;;) {
    const data = await twitterFetch(
      endpoint,
      queryId,
      cursor === undefined ? variables : { ...variables, cursor },
    );
    const instructions = path.reduce<unknown>(
      (node, key) => obj(node)[key],
      data,
    );
    if (!Array.isArray(instructions)) {
      const message = obj(
        (obj(data).errors as unknown[] | undefined)?.[0],
      ).message;
      if (typeof message === "string") {
        throwTwitterApiError(endpoint, 200, message);
      }
      return;
    }
    yield instructions;
    const next = bottomCursor(instructions);
    if (!next || next === cursor) return;
    cursor = next;
  }
}

/** Users across pages until `limit` rows or a page adds none. */
export async function collectTimelineUsers(
  pages: AsyncIterable<unknown[]>,
  limit: number,
): Promise<UserData[]> {
  const users = new Map<string, UserData>();
  for await (const instructions of pages) {
    const before = users.size;
    for (const user of extractUsersFromInstructions(instructions)) {
      if (!users.has(user.id)) users.set(user.id, user);
    }
    if (users.size >= limit || users.size === before) break;
  }
  return [...users.values()].slice(0, limit);
}

/**
 * Tweets across pages until `limit` rows or a page adds none. With `since`
 * (epoch ms), rows posted earlier are dropped, and `stopAtSince` ends a
 * newest-first timeline at the first entry whose newest post is older.
 */
export async function collectTimelineTweets(
  pages: AsyncIterable<unknown[]>,
  options: { limit: number; since?: number; stopAtSince: boolean },
): Promise<TweetData[]> {
  const { limit, since, stopAtSince } = options;
  const postedAt = (tweet: TweetData) => Date.parse(tweet.created_at);
  const tweets = new Map<string, TweetData>();
  const seen = new Set<string>();
  for await (const instructions of pages) {
    let fresh = 0;
    let pastSince = false;
    for (const entry of entryTweets(instructions)) {
      if (
        since !== undefined &&
        stopAtSince &&
        Math.max(...entry.map(postedAt)) < since
      ) {
        pastSince = true;
      }
      for (const tweet of entry) {
        if (seen.has(tweet.id)) continue;
        seen.add(tweet.id);
        fresh += 1;
        if (since === undefined || postedAt(tweet) >= since) {
          tweets.set(tweet.id, tweet);
        }
      }
    }
    if (tweets.size >= limit || pastSince || fresh === 0) break;
  }
  return [...tweets.values()].slice(0, limit);
}

/** Epoch ms of an ISO 8601 `--since` date or datetime; a bare date is UTC midnight. */
export function sinceArg(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const time = Date.parse(String(value));
  if (Number.isNaN(time)) {
    throw invalidTwitterInput(
      `--since must be an ISO 8601 date or datetime, got "${String(value)}"`,
      "Pass a value such as 2026-11-01 or 2026-11-01T08:00:00Z.",
    );
  }
  return time;
}

const USER_BY_SCREEN_NAME_QUERY_ID = "AMIBMjtxEEATh4z8V9GtRg";

/** Numeric id of a handle, or null when X has no such account. */
export async function lookupUserId(screenName: string): Promise<string | null> {
  const data = await twitterFetch(
    "UserByScreenName",
    USER_BY_SCREEN_NAME_QUERY_ID,
    { screen_name: screenName.replace(/^@/, "") },
  );
  const result = obj(obj(obj(data).data).user).result;
  return obj(result).__typename === "User" &&
    typeof obj(result).rest_id === "string"
    ? (obj(result).rest_id as string)
    : null;
}

/** Numeric id for a handle (`name` or `@name`) or a numeric id. */
export async function userIdArg(value: unknown): Promise<string> {
  const user = String(value ?? "").trim();
  if (/^\d+$/.test(user)) return user;
  const id = user ? await lookupUserId(user) : null;
  if (id) return id;
  throw Object.assign(
    new Error(`Twitter/X has no account @${user.replace(/^@/, "")}`),
    {
      code: "not_found",
      retryable: false,
      suggestion: "Check the handle, or pass the numeric user id.",
    },
  );
}

const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;

/** Runs `call`; after a 429 whose window resets within 15 minutes, waits for the reset and runs it once more. */
export async function withRateLimitWait<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const { code, rateLimitResetMs } = error as {
      code?: string;
      rateLimitResetMs?: number;
    };
    const wait =
      rateLimitResetMs === undefined
        ? Number.NaN
        : rateLimitResetMs - Date.now();
    if (code !== "rate_limited" || !(wait <= MAX_RATE_LIMIT_WAIT_MS))
      throw error;
    await sleep(Math.max(wait, 0) + 1000);
    return call();
  }
}
