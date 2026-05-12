/**
 * @owner   src/adapters/twitter/tweet-url.ts
 * @does    Provide exact Twitter/X tweet URL parsing and DOM target scoping helpers implemented with site-specific safety checks.
 * @needs   Full https Twitter/X status URLs and browser DOM roots containing status links.
 * @feeds   Twitter write-action adapters and agent-facing quote/retweet safety checks.
 * @breaks  Twitter URL shape drift or substring matching can target the wrong tweet.
 */

const TWEET_PATH_PATTERN = /^\/(?:[^/]+|i)\/status\/(\d+)\/?$/;
const TWITTER_HOSTS = new Set(["x.com", "twitter.com"]);

interface ParsedTweetUrl {
  id: string;
  url: string;
}

function isTwitterHost(hostname: string): boolean {
  return (
    TWITTER_HOSTS.has(hostname) ||
    hostname.endsWith(".x.com") ||
    hostname.endsWith(".twitter.com")
  );
}

export function parseTwitterTweetUrl(value: unknown): ParsedTweetUrl {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("twitter tweet URL cannot be empty.");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid tweet URL: ${raw}.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !isTwitterHost(hostname)) {
    throw new Error(`Invalid tweet URL host: ${raw}.`);
  }
  const match = parsed.pathname.match(TWEET_PATH_PATTERN);
  if (!match?.[1])
    throw new Error(`Could not extract tweet ID from URL: ${raw}.`);
  return { id: match[1], url: parsed.toString() };
}

export function buildTwitterArticleScopeSource(tweetId: string): string {
  return `
    const tweetId = ${JSON.stringify(tweetId)};
    const __twTweetPathRe = /^\\/(?:[^/]+|i)\\/status\\/(\\d+)\\/?$/;
    const __twIsTwitterHost = (hostname) => hostname === 'x.com'
      || hostname === 'twitter.com'
      || hostname.endsWith('.x.com')
      || hostname.endsWith('.twitter.com');
    const __twGetStatusIdFromHref = (href) => {
      try {
        const parsed = new URL(href, window.location.origin);
        if (parsed.protocol !== 'https:' || !__twIsTwitterHost(parsed.hostname.toLowerCase())) return null;
        return parsed.pathname.match(__twTweetPathRe)?.[1] || null;
      } catch {
        return null;
      }
    };
    const __twHasLinkToTarget = (root) => Array.from(root.querySelectorAll('a[href*="/status/"]'))
      .some((link) => __twGetStatusIdFromHref(link.href) === tweetId);
    const findTargetArticle = () => Array.from(document.querySelectorAll('article')).find(__twHasLinkToTarget);
  `;
}
