/**
 * Twitter trending — fetch trending topics via the v2 guide API.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import { twitterGuideFetch } from "./client.js";

const GUIDE_URL = "https://x.com/i/api/2/guide.json";

cli({
  site: "twitter",
  name: "trending",
  description: "Get trending topics",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  columns: ["name", "tweet_count", "description", "url"],
  func: async (_page, kwargs) => {
    const count = (kwargs.limit as number) ?? 20;

    const data = (await twitterGuideFetch(GUIDE_URL, {
      count: String(count),
      include_page_configuration: "false",
    })) as Record<string, unknown>;

    // Navigate: data.timeline.instructions[0].addEntries.entries
    const timeline = data.timeline as Record<string, unknown> | undefined;
    const instructions = (timeline?.instructions as unknown[]) ?? [];

    const trends: Array<{
      name: string;
      tweet_count: string;
      description: string;
      url: string;
    }> = [];

    for (const instruction of instructions) {
      const inst = instruction as Record<string, unknown>;
      const addEntries = inst.addEntries as Record<string, unknown> | undefined;
      if (!addEntries) continue;

      const entries = (addEntries.entries as unknown[]) ?? [];

      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const content = e.content as Record<string, unknown> | undefined;
        if (!content) continue;

        // Trend items are nested in timelineModule or timelineItem
        const items =
          (content.items as unknown[]) ??
          (content.item ? [{ item: content.item }] : []);

        for (const item of items) {
          const i = item as Record<string, unknown>;
          const itemObj = (i.item ?? i) as Record<string, unknown>;
          const clientEventInfo = itemObj.clientEventInfo as
            | Record<string, unknown>
            | undefined;
          const details = clientEventInfo?.details as
            | Record<string, unknown>
            | undefined;
          const guideDetails = details?.guideDetails as
            | Record<string, unknown>
            | undefined;
          const transparentGuideDetails =
            guideDetails?.transparentGuideDetails as
              | Record<string, unknown>
              | undefined;
          const trendMetadata = transparentGuideDetails?.trendMetadata as
            | Record<string, unknown>
            | undefined;

          // Also try direct content path
          const itemContent = (
            itemObj as Record<string, Record<string, unknown>>
          ).content;
          const trend = itemContent?.trend as
            | Record<string, unknown>
            | undefined;

          const name =
            (trendMetadata?.trendName as string) ??
            (trend?.name as string) ??
            "";
          if (!name) continue;

          const tweetCount =
            (trendMetadata?.metaDescription as string) ??
            (trend?.tweetCount as string) ??
            "";
          const desc =
            (trend?.description as string) ??
            (trendMetadata?.metaDescription as string) ??
            "";
          const trendUrl = trend?.url as Record<string, unknown> | undefined;

          trends.push({
            name,
            tweet_count: tweetCount,
            description: desc,
            url:
              (trendUrl?.url as string) ??
              `https://x.com/search?q=${encodeURIComponent(name)}`,
          });
        }
      }
    }

    return trends.slice(0, count);
  },
});
