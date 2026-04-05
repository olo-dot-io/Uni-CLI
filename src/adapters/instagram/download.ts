/**
 * Instagram download — download images and videos from posts and reels.
 *
 * Uses GraphQL API to fetch media URLs, then downloads via HTTP.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import type { IPage } from "../../types.js";

const GRAPHQL_DOC_ID = "8845758582119845";
const APP_ID = "936619743392459";

function buildFetchScript(shortcode: string): string {
  return `
    (async () => {
      const shortcode = ${JSON.stringify(shortcode)};
      const docId = ${JSON.stringify(GRAPHQL_DOC_ID)};
      const variables = {
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      };
      const url = 'https://www.instagram.com/graphql/query/?doc_id=' + docId + '&variables=' + encodeURIComponent(JSON.stringify(variables));
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json,text/plain,*/*',
          'X-IG-App-ID': ${JSON.stringify(APP_ID)},
        },
      });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const data = await res.json();
      const media = data?.data?.xdt_shortcode_media;
      if (!media) return { ok: false, error: 'Post not found or private' };

      const nodes = Array.isArray(media?.edge_sidecar_to_children?.edges) && media.edge_sidecar_to_children.edges.length > 0
        ? media.edge_sidecar_to_children.edges.map(e => e?.node).filter(Boolean)
        : [media];

      const items = nodes.map(node => ({
        type: node?.is_video ? 'video' : 'image',
        url: String(node?.is_video ? (node?.video_url || '') : (node?.display_url || '')),
      })).filter(item => item.url);

      return {
        ok: true,
        shortcode: media.shortcode || shortcode,
        owner: media?.owner?.username || '',
        items,
      };
    })()
  `;
}

function parseShortcode(input: string): string {
  const url = new URL(input);
  const segments = url.pathname.split("/").filter(Boolean);
  const kinds = new Set(["p", "reel", "tv"]);
  if (segments.length >= 2 && kinds.has(segments[0]!)) return segments[1]!;
  if (segments.length >= 3 && kinds.has(segments[1]!)) return segments[2]!;
  throw new Error(`Cannot parse shortcode from: ${input}`);
}

cli({
  site: "instagram",
  name: "download",
  description: "Download images and videos from Instagram posts and reels",
  domain: "www.instagram.com",
  strategy: Strategy.INTERCEPT,
  browser: true,
  args: [
    {
      name: "url",
      positional: true,
      required: true,
      description: "Instagram post/reel URL",
    },
  ],
  columns: ["status", "shortcode", "count", "items"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const shortcode = parseShortcode(String(kwargs.url));

    await p.goto("https://www.instagram.com/");
    const result = (await p.evaluate(buildFetchScript(shortcode))) as {
      ok: boolean;
      shortcode?: string;
      owner?: string;
      items?: Array<{ type: string; url: string }>;
      error?: string;
    };

    if (!result?.ok) {
      throw new Error(result?.error ?? "Failed to fetch media");
    }

    const items = result.items ?? [];
    return [
      {
        status: "Found",
        shortcode: result.shortcode ?? shortcode,
        count: items.length,
        items: items
          .map((i) => `${i.type}: ${i.url.substring(0, 80)}...`)
          .join("; "),
      },
    ];
  },
});
