/**
 * Twitter accept — accept a pending follow request via REST API.
 *
 * Uses the v1.1 REST endpoint since there is no public GraphQL mutation for this.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";

const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

cli({
  site: "twitter",
  name: "accept",
  description: "Accept a pending follow request",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "user_id",
      required: true,
      positional: true,
      description: "User numeric ID whose follow request to accept",
    },
  ],
  columns: ["status", "id"],
  func: async (_page, kwargs) => {
    const userId = String(kwargs.user_id);

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

    const params = new URLSearchParams({ user_id: userId });
    const url = `https://x.com/1.1/friendships/accept.json?${params.toString()}`;

    const resp = await fetch(url, {
      method: "POST",
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
        `Twitter API error: HTTP ${resp.status} on accept\n` +
          `${preview.slice(0, 200)}`,
      );
    }

    return [{ status: "ok", id: userId }];
  },
});
