/**
 * YouTube video info — retrieve metadata for a single video.
 *
 * Uses InnerTube "player" endpoint for rich metadata (title, description,
 * view count, likes, duration, publish date).
 */

import { cli, Strategy } from "../../registry.js";
import { innertubeFetch } from "./innertube.js";

interface PlayerResponse {
  videoDetails?: {
    title?: string;
    author?: string;
    shortDescription?: string;
    viewCount?: string;
    lengthSeconds?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      publishDate?: string;
      likes?: number;
    };
  };
}

cli({
  site: "youtube",
  name: "video",
  description: "Get YouTube video info",
  domain: "www.youtube.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "videoId",
      type: "str",
      required: true,
      positional: true,
      description: "YouTube video ID",
    },
  ],
  columns: ["title", "author", "views", "duration", "publishDate"],
  async func(_page, kwargs) {
    const videoId = kwargs.videoId as string;

    const data = (await innertubeFetch("player", {
      videoId,
    })) as PlayerResponse;

    const details = data.videoDetails ?? {};
    const micro = data.microformat?.playerMicroformatRenderer ?? {};

    return {
      title: details.title ?? "",
      author: details.author ?? "",
      description: details.shortDescription ?? "",
      views: details.viewCount ?? "",
      likes: micro.likes ?? null,
      duration: details.lengthSeconds ?? "",
      publishDate: micro.publishDate ?? "",
      url: `https://youtube.com/watch?v=${videoId}`,
    };
  },
});
