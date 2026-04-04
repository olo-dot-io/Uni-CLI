/**
 * Twitter GraphQL client — authenticated API access via browser cookies.
 *
 * Uses the public GraphQL endpoint at x.com with cookie-based authentication.
 * Requires ct0 (CSRF token) and auth_token cookies in ~/.unicli/cookies/twitter.json
 */

import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";

const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const GRAPHQL_BASE = "https://x.com/i/api/graphql";

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

/**
 * Make an authenticated GraphQL GET request to the Twitter API.
 *
 * @param endpoint - GraphQL operation name (e.g. "SearchTimeline")
 * @param queryId - GraphQL query ID (e.g. "nK1dw4oV3k4w5TdtcAdSww")
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
  const cookies = loadCookies("twitter");
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

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
  });

  const url = `${GRAPHQL_BASE}/${queryId}/${endpoint}?${params.toString()}`;

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
    throw new Error(
      `Twitter API error: HTTP ${resp.status} on ${endpoint}\n` +
        `${preview.slice(0, 200)}`,
    );
  }

  return resp.json();
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
  const cookies = loadCookies("twitter");
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
    throw new Error(
      `Twitter REST API error: HTTP ${resp.status} on ${path}\n` +
        `${preview.slice(0, 200)}`,
    );
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
  const cookies = loadCookies("twitter");
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
    throw new Error(
      `Twitter Guide API error: HTTP ${resp.status}\n` +
        `${preview.slice(0, 200)}`,
    );
  }

  return resp.json();
}

interface TweetData {
  id: string;
  author: string;
  text: string;
  likes: number;
  retweets: number;
  views: string;
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

  const core = tweetResult.core as Record<string, unknown> | undefined;
  const userResults = core?.user_results as Record<string, unknown> | undefined;
  const userResult = userResults?.result as Record<string, unknown> | undefined;
  const userLegacy = userResult?.legacy as Record<string, unknown> | undefined;
  const screenName = (userLegacy?.screen_name as string) ?? "unknown";

  const legacy = tweetResult.legacy as Record<string, unknown> | undefined;
  const fullText = (legacy?.full_text as string) ?? "";
  const favoriteCount = (legacy?.favorite_count as number) ?? 0;
  const retweetCount = (legacy?.retweet_count as number) ?? 0;

  const views = tweetResult.views as Record<string, unknown> | undefined;
  const viewCount = (views?.count as string) ?? "0";

  return {
    id: restId,
    author: screenName,
    text: fullText,
    likes: favoriteCount,
    retweets: retweetCount,
    views: viewCount,
    url: `https://x.com/${screenName}/status/${restId}`,
  };
}

/**
 * Extract tweets from timeline instructions (common pattern for search, home, bookmarks).
 *
 * Timeline instructions contain entries with tweet results nested inside.
 */
export function extractTweetsFromInstructions(
  instructions: unknown[],
): TweetData[] {
  const tweets: TweetData[] = [];

  for (const instruction of instructions) {
    const inst = instruction as Record<string, unknown>;
    const type = inst.type as string | undefined;

    // Handle TimelineAddEntries
    if (type === "TimelineAddEntries") {
      const entries = (inst.entries as unknown[]) ?? [];
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const content = e.content as Record<string, unknown> | undefined;
        if (!content) continue;

        const entryType = content.entryType as string | undefined;

        if (entryType === "TimelineTimelineItem") {
          const itemContent = content.itemContent as
            | Record<string, unknown>
            | undefined;
          if (
            itemContent &&
            (itemContent.itemType as string) === "TimelineTweet"
          ) {
            const tweetResults = itemContent.tweet_results as
              | Record<string, unknown>
              | undefined;
            if (tweetResults?.result) {
              const tweet = extractTweet(
                tweetResults.result as Record<string, unknown>,
              );
              if (tweet) tweets.push(tweet);
            }
          }
        } else if (entryType === "TimelineTimelineModule") {
          // Module entries (e.g. conversations) contain nested items
          const items = (content.items as unknown[]) ?? [];
          for (const item of items) {
            const i = item as Record<string, unknown>;
            const itemObj = i.item as Record<string, unknown> | undefined;
            const itemContent = itemObj?.itemContent as
              | Record<string, unknown>
              | undefined;
            if (
              itemContent &&
              (itemContent.itemType as string) === "TimelineTweet"
            ) {
              const tweetResults = itemContent.tweet_results as
                | Record<string, unknown>
                | undefined;
              if (tweetResults?.result) {
                const tweet = extractTweet(
                  tweetResults.result as Record<string, unknown>,
                );
                if (tweet) tweets.push(tweet);
              }
            }
          }
        }
      }
    }
  }

  return tweets;
}
