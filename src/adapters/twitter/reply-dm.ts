/**
 * Twitter reply-dm — send a DM reply via the v1.1 direct_messages endpoint.
 *
 * Uses REST API since DM sending uses a different endpoint than GraphQL mutations.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";

const BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

cli({
  site: "twitter",
  name: "reply-dm",
  description: "Reply to a DM conversation",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "conversation_id",
      required: true,
      positional: true,
      description: "DM conversation ID",
    },
    {
      name: "text",
      required: true,
      description: "Message text to send",
    },
  ],
  columns: ["status", "id"],
  func: async (_page, kwargs) => {
    const conversationId = String(kwargs.conversation_id);
    const text = kwargs.text as string;

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

    const url = "https://x.com/1.1/dm/new2.json";

    const body = {
      conversation_id: conversationId,
      recipient_ids: false,
      request_id: crypto.randomUUID(),
      text,
      cards_platform: "Web-12",
      include_cards: 1,
      include_quote_count: true,
      dm_users: false,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BEARER_TOKEN}`,
        "X-Csrf-Token": ct0,
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Cookie: formatCookieHeader(cookies),
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const preview = await resp.text().catch(() => "");
      throw new Error(
        `Twitter API error: HTTP ${resp.status} on reply-dm\n` +
          `${preview.slice(0, 200)}`,
      );
    }

    const data = (await resp.json()) as Record<string, unknown>;
    const entries = data.entries as unknown[] | undefined;
    const firstEntry = (entries?.[0] ?? {}) as Record<string, unknown>;
    const message = firstEntry.message as Record<string, unknown> | undefined;
    const messageId = (message?.id as string) ?? conversationId;

    return [{ status: "ok", id: messageId }];
  },
});
