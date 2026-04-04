/**
 * YouTube search — find videos by query.
 *
 * Uses InnerTube "search" endpoint with EgIQAQ%3D%3D param (video filter).
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
  async func(_page, kwargs) {
    const query = kwargs.query as string;
    const limit = (kwargs.limit as number) ?? 10;

    const data = (await innertubeFetch("search", {
      query,
      params: "EgIQAQ%3D%3D", // video filter
    })) as SearchResponse;

    return extractVideos(data).slice(0, limit);
  },
});
