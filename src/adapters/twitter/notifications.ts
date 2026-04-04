/**
 * Twitter notifications — fetch recent notifications via REST API.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterRestFetch } from "./client.js";

cli({
  site: "twitter",
  name: "notifications",
  description: "Get recent notifications",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  columns: ["type", "message", "timestamp", "url"],
  func: async (_page, kwargs) => {
    const count = Math.min((kwargs.limit as number) ?? 20, 50);

    const data = (await twitterRestFetch("/2/notifications/all.json", {
      include_profile_interstitial_type: "1",
      include_blocking: "1",
      include_blocked_by: "1",
      include_followed_by: "1",
      include_want_retweets: "1",
      include_mute_edge: "1",
      include_can_dm: "1",
      include_can_media_tag: "1",
      include_ext_is_blue_verified: "1",
      count: String(count),
    })) as Record<string, unknown>;

    const globalObjects = data.globalObjects as
      | Record<string, unknown>
      | undefined;
    const notifications = globalObjects?.notifications as
      | Record<string, Record<string, unknown>>
      | undefined;
    const tweets = globalObjects?.tweets as
      | Record<string, Record<string, unknown>>
      | undefined;
    const users = globalObjects?.users as
      | Record<string, Record<string, unknown>>
      | undefined;

    if (!notifications) return [];

    const results: Array<{
      type: string;
      message: string;
      timestamp: string;
      url: string;
    }> = [];

    for (const [, notif] of Object.entries(notifications)) {
      const message = notif.message as Record<string, unknown> | undefined;
      const text = (message?.text as string) ?? "";

      // Resolve user names from entities
      const entities = (message?.entities as unknown[]) ?? [];
      let resolvedText = text;
      for (const entity of entities) {
        const ent = entity as Record<string, unknown>;
        const ref = ent.ref as Record<string, unknown> | undefined;
        if (ref?.user) {
          const userId = (ref.user as Record<string, unknown>).id as string;
          const user = users?.[userId];
          if (user) {
            const placeholder = (ent.format as Record<string, unknown>)
              ?.format as string;
            if (placeholder) {
              resolvedText = resolvedText.replace(
                placeholder,
                `@${user.screen_name as string}`,
              );
            }
          }
        }
      }

      // Find the associated tweet URL if any
      const tweetNotif = notif.template as Record<string, unknown> | undefined;
      const aggregateUserActionsV1 = tweetNotif?.aggregateUserActionsV1 as
        | Record<string, unknown>
        | undefined;
      const targetObjects = aggregateUserActionsV1?.targetObjects as
        | unknown[]
        | undefined;
      let url = "https://x.com/notifications";

      if (targetObjects?.length) {
        const target = targetObjects[0] as Record<string, unknown>;
        const tweetId = (target.tweet as Record<string, unknown>)?.id as
          | string
          | undefined;
        if (tweetId && tweets?.[tweetId]) {
          const tweetUser = tweets[tweetId].user_id_str as string;
          const screenName = users?.[tweetUser]?.screen_name as string;
          if (screenName) {
            url = `https://x.com/${screenName}/status/${tweetId}`;
          }
        }
      }

      results.push({
        type:
          ((notif.icon as Record<string, unknown>)?.id as string) ??
          "notification",
        message: resolvedText || text,
        timestamp: (notif.timestampMs as string) ?? "",
        url,
      });
    }

    return results.slice(0, count);
  },
});
