/**
 * @owner       src::adapters::youtube::channel-videos
 * @does        Lists a channel's recent uploads with exact publish times, newest first, from a UC id, an @handle or a channel URL.
 * @needs       The shared InnerTube client: navigation/resolve_url for handles, browse with the Videos tab, player microformat for dates.
 * @feeds       Research watchers that follow lab and lecture channels next to their feeds (the channel RSS answers HTTP 404).
 * @breaks      A missing Videos tab or a renderer drift raises instead of returning rows; a video whose player has no publishDate keeps its relative age only.
 * @invariants  Every row carries the video id and a canonical watch URL; `published` is ISO 8601 from the player microformat.
 * @side-effects Public HTTPS reads only.
 * @perf        One resolve, one browse per 30 uploads and one player call per row, four at a time.
 * @concurrency safe across invocations.
 * @test        Live run against a public channel (`unicli youtube channel-videos @AndrejKarpathy --limit 3`).
 * @stability   experimental
 * @since       2026-11-03
 */

import { cli, Strategy } from "../../registry.js";
import { mapConcurrent } from "../../engine/download.js";
import { innertubeFetch } from "./innertube.js";

// The browse params that select a channel's Videos tab.
const VIDEOS_TAB = "EgZ2aWRlb3PyBgQKAjoA";

interface Lockup {
  contentId?: string;
  contentType?: string;
  metadata?: {
    lockupMetadataViewModel?: {
      title?: { content?: string };
      metadata?: {
        contentMetadataViewModel?: {
          metadataRows?: Array<{
            metadataParts?: Array<{ text?: { content?: string } }>;
          }>;
        };
      };
    };
  };
}

interface GridItem {
  richItemRenderer?: { content?: { lockupViewModel?: Lockup } };
  continuationItemRenderer?: {
    continuationEndpoint?: { continuationCommand?: { token?: string } };
  };
}

async function channelId(channel: string): Promise<string> {
  if (/^UC[\w-]{22}$/.test(channel)) return channel;
  const url = channel.startsWith("http")
    ? channel
    : `https://www.youtube.com/${channel.startsWith("@") ? channel : `@${channel}`}`;
  const resolved = (await innertubeFetch("navigation/resolve_url", {
    url,
  })) as {
    endpoint?: { browseEndpoint?: { browseId?: string } };
  };
  const id = resolved.endpoint?.browseEndpoint?.browseId;
  if (!id?.startsWith("UC")) {
    throw new Error(`YouTube did not resolve ${channel} to a channel id`);
  }
  return id;
}

function firstPage(data: unknown): GridItem[] {
  const tabs =
    (
      data as {
        contents?: {
          twoColumnBrowseResultsRenderer?: {
            tabs?: Array<{
              tabRenderer?: {
                selected?: boolean;
                title?: string;
                content?: { richGridRenderer?: { contents?: GridItem[] } };
              };
            }>;
          };
        };
      }
    ).contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  const tab = tabs.find(
    (candidate) => candidate.tabRenderer?.selected,
  )?.tabRenderer;
  const items = tab?.content?.richGridRenderer?.contents;
  if (!items) {
    throw new Error(
      "YouTube returned no Videos tab for this channel (renderer drift or a channel without uploads)",
    );
  }
  return items;
}

function nextPage(data: unknown): GridItem[] {
  const actions =
    (
      data as {
        onResponseReceivedActions?: Array<{
          appendContinuationItemsAction?: { continuationItems?: GridItem[] };
        }>;
      }
    ).onResponseReceivedActions ?? [];
  return actions.flatMap(
    (action) => action.appendContinuationItemsAction?.continuationItems ?? [],
  );
}

function row(lockup: Lockup) {
  const meta = lockup.metadata?.lockupMetadataViewModel;
  const parts = (
    meta?.metadata?.contentMetadataViewModel?.metadataRows ?? []
  ).flatMap((metadataRow) => metadataRow.metadataParts ?? []);
  const texts = parts.map((part) => part.text?.content ?? "");
  return {
    id: lockup.contentId as string,
    title: meta?.title?.content ?? "",
    views: texts.find((text) => /views?$/.test(text)) ?? "",
    age: texts.find((text) => text.endsWith("ago")) ?? "",
    url: `https://www.youtube.com/watch?v=${lockup.contentId}`,
  };
}

cli({
  site: "youtube",
  name: "channel-videos",
  description:
    "List a YouTube channel's recent uploads with exact publish times",
  domain: "www.youtube.com",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "channel",
      type: "str",
      required: true,
      positional: true,
      description: "Channel id (UC...), @handle or channel URL",
    },
    {
      name: "limit",
      type: "int",
      default: 10,
      description: "Uploads to return, newest first",
    },
  ],
  columns: ["published", "title", "views", "id", "url"],
  operation_effect: "read",
  execution_operator: "structured-api",
  capabilities: ["http.fetch"],
  async func(_page, kwargs) {
    const limit = Math.max(1, (kwargs.limit as number) ?? 10);
    const browseId = await channelId(String(kwargs.channel).trim());
    let items = firstPage(
      await innertubeFetch("browse", { browseId, params: VIDEOS_TAB }),
    );
    const lockups: Lockup[] = [];
    while (true) {
      lockups.push(
        ...items
          .map((item) => item.richItemRenderer?.content?.lockupViewModel)
          .filter(
            (lockup): lockup is Lockup =>
              Boolean(lockup?.contentId) &&
              lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO",
          ),
      );
      const token = items.find((item) => item.continuationItemRenderer)
        ?.continuationItemRenderer?.continuationEndpoint?.continuationCommand
        ?.token;
      if (lockups.length >= limit || !token) break;
      items = nextPage(await innertubeFetch("browse", { continuation: token }));
    }
    return mapConcurrent(lockups.slice(0, limit).map(row), 4, async (video) => {
      const player = (await innertubeFetch("player", {
        videoId: video.id,
      })) as {
        microformat?: { playerMicroformatRenderer?: { publishDate?: string } };
      };
      const published =
        player.microformat?.playerMicroformatRenderer?.publishDate;
      return {
        ...video,
        published: published ? new Date(published).toISOString() : "",
      };
    });
  },
});
