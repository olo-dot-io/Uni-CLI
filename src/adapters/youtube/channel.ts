/**
 * YouTube channel info — retrieve channel metadata by channel ID.
 *
 * Uses InnerTube "browse" endpoint with browseId set to the channel ID.
 */

import { cli, Strategy } from "../../registry.js";
import { innertubeFetch } from "./innertube.js";

interface ChannelResponse {
  metadata?: {
    channelMetadataRenderer?: {
      title?: string;
      description?: string;
      channelUrl?: string;
    };
  };
  header?: {
    c4TabbedHeaderRenderer?: {
      subscriberCountText?: { simpleText?: string };
    };
  };
}

cli({
  site: "youtube",
  name: "channel",
  description: "Get YouTube channel info",
  domain: "www.youtube.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "channelId",
      type: "str",
      required: true,
      positional: true,
      description: "YouTube channel ID (e.g. UCxxxxxx)",
    },
  ],
  columns: ["name", "subscribers", "url"],
  async func(_page, kwargs) {
    const channelId = kwargs.channelId as string;

    const data = (await innertubeFetch("browse", {
      browseId: channelId,
    })) as ChannelResponse;

    const meta = data.metadata?.channelMetadataRenderer ?? {};
    const header = data.header?.c4TabbedHeaderRenderer ?? {};

    return {
      name: meta.title ?? "",
      subscribers: header.subscriberCountText?.simpleText ?? "",
      description: meta.description ?? "",
      url: meta.channelUrl ?? `https://youtube.com/channel/${channelId}`,
    };
  },
});
