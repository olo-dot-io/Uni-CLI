/**
 * Twitter download — download media (images/video) from a tweet via GraphQL TweetDetail.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterFetch, FEATURES } from "./client.js";

const QUERY_ID = "xOhkmRac04YFZmOzU9PJHg";
const ENDPOINT = "TweetDetail";

interface MediaItem {
  type: string;
  url: string;
  width: number;
  height: number;
}

cli({
  site: "twitter",
  name: "download",
  description: "Get media URLs from a tweet (images and video)",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "tweet_id",
      required: true,
      positional: true,
      description: "Tweet ID to download media from",
    },
  ],
  columns: ["type", "url", "width", "height"],
  func: async (_page, kwargs) => {
    const tweetId = String(kwargs.tweet_id);

    const variables = {
      focalTweetId: tweetId,
      with_rux_injections: false,
      includePromotedContent: false,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: false,
      withBirdwatchNotes: false,
      withVoice: true,
      withV2Timeline: true,
    };

    const data = (await twitterFetch(
      ENDPOINT,
      QUERY_ID,
      variables,
      FEATURES,
    )) as Record<string, unknown>;

    // Navigate: data.threaded_conversation_with_injections_v2.instructions
    const root = data.data as Record<string, unknown> | undefined;
    const conversation = root?.threaded_conversation_with_injections_v2 as
      | Record<string, unknown>
      | undefined;
    const instructions = (conversation?.instructions as unknown[]) ?? [];

    const media: MediaItem[] = [];

    for (const instruction of instructions) {
      const inst = instruction as Record<string, unknown>;
      if ((inst.type as string) !== "TimelineAddEntries") continue;

      const entries = (inst.entries as unknown[]) ?? [];
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const content = e.content as Record<string, unknown> | undefined;
        if (!content) continue;

        const itemContent = content.itemContent as
          | Record<string, unknown>
          | undefined;
        if (!itemContent) continue;

        const tweetResults = itemContent.tweet_results as
          | Record<string, unknown>
          | undefined;
        const result = tweetResults?.result as
          | Record<string, unknown>
          | undefined;
        if (!result) continue;

        // Unwrap tweet_with_visibility_results
        const tweetObj = (result.tweet ?? result) as Record<string, unknown>;
        const restId = tweetObj.rest_id as string | undefined;
        if (restId !== tweetId) continue;

        const legacy = tweetObj.legacy as Record<string, unknown> | undefined;
        const extendedEntities = legacy?.extended_entities as
          | Record<string, unknown>
          | undefined;
        const mediaEntities = (extendedEntities?.media as unknown[]) ?? [];

        for (const m of mediaEntities) {
          const mediaObj = m as Record<string, unknown>;
          const mediaType = mediaObj.type as string;

          if (mediaType === "photo") {
            media.push({
              type: "photo",
              url: (mediaObj.media_url_https as string) ?? "",
              width:
                ((mediaObj.original_info as Record<string, unknown>)
                  ?.width as number) ?? 0,
              height:
                ((mediaObj.original_info as Record<string, unknown>)
                  ?.height as number) ?? 0,
            });
          } else if (mediaType === "video" || mediaType === "animated_gif") {
            const videoInfo = mediaObj.video_info as
              | Record<string, unknown>
              | undefined;
            const variants = (videoInfo?.variants as unknown[]) ?? [];

            // Pick highest bitrate mp4 variant
            let bestUrl = "";
            let bestBitrate = -1;
            for (const v of variants) {
              const variant = v as Record<string, unknown>;
              if ((variant.content_type as string) !== "video/mp4") continue;
              const bitrate = (variant.bitrate as number) ?? 0;
              if (bitrate > bestBitrate) {
                bestBitrate = bitrate;
                bestUrl = (variant.url as string) ?? "";
              }
            }

            if (bestUrl) {
              media.push({
                type: mediaType,
                url: bestUrl,
                width:
                  ((mediaObj.original_info as Record<string, unknown>)
                    ?.width as number) ?? 0,
                height:
                  ((mediaObj.original_info as Record<string, unknown>)
                    ?.height as number) ?? 0,
              });
            }
          }
        }
      }
    }

    return media;
  },
});
