/**
 * @owner       src::adapters::youtube::search
 * @does        Searches YouTube's public InnerTube video result surface by query.
 * @needs       The shared InnerTube client and current video renderer shape.
 * @feeds       YouTube discovery and registry-driven AI talk/tutorial intelligence.
 * @breaks      InnerTube or renderer drift must surface instead of returning fabricated video rows.
 * @invariants  Every result includes a canonical watch URL and video identifier.
 * @side-effects Public HTTPS read only.
 * @perf        Parses one bounded search response.
 * @concurrency safe across invocations.
 * @test        YouTube adapter tests and tests/unit/commands/ai.test.ts
 * @stability   experimental
 * @since       2026-07-17
 */

import { cli, Strategy } from "../../registry.js";
import { innertubeFetch } from "./innertube.js";

interface VideoRenderer {
  videoId?: string;
  title?: { runs?: Array<{ text: string }> };
  ownerText?: { runs?: Array<{ text: string }> };
  viewCountText?: { simpleText?: string };
}

interface SectionContent {
  itemSectionRenderer?: {
    contents?: Array<{ videoRenderer?: VideoRenderer }>;
  };
}

interface SearchResponse {
  contents?: {
    twoColumnSearchResultsRenderer?: {
      primaryContents?: {
        sectionListRenderer?: {
          contents?: SectionContent[];
        };
      };
    };
  };
}

function extractVideos(data: SearchResponse): Array<Record<string, unknown>> {
  const sections =
    data.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents ?? [];

  const items = sections[0]?.itemSectionRenderer?.contents ?? [];

  return items
    .filter((item) => item.videoRenderer?.videoId)
    .map((item) => {
      const v = item.videoRenderer!;
      const videoId = v.videoId ?? "";
      return {
        title: v.title?.runs?.map((r) => r.text).join("") ?? "",
        channel: v.ownerText?.runs?.[0]?.text ?? "",
        views: v.viewCountText?.simpleText ?? "",
        videoId,
        url: `https://youtube.com/watch?v=${videoId}`,
      };
    });
}

cli({
  site: "youtube",
  name: "search",
  description: "Search YouTube videos",
  domain: "www.youtube.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "query",
      type: "str",
      required: true,
      positional: true,
      description: "Search query",
    },
    {
      name: "limit",
      type: "int",
      default: 10,
      description: "Max results to return",
    },
  ],
  columns: ["title", "channel", "views", "videoId"],
  capabilities: ["http.fetch", "ai.search", "ai.community", "ai.video"],
  async func(_page, kwargs) {
    const query = kwargs.query as string;
    const limit = (kwargs.limit as number) ?? 10;

    const data = (await innertubeFetch("search", {
      query,
      params: "EgIQAQ%3D%3D",
    })) as SearchResponse;

    return extractVideos(data).slice(0, limit);
  },
});
