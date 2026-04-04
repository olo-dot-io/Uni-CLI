/**
 * YouTube InnerTube client — low-level API wrapper for YouTube's internal API.
 *
 * InnerTube is YouTube's internal RPC layer. Public endpoints don't require
 * authentication for most read operations (search, player, browse, next).
 */

import { USER_AGENT } from "../../constants.js";

const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const INNERTUBE_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20240101.00.00",
  hl: "en",
  gl: "US",
};

export async function innertubeFetch(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${INNERTUBE_API_KEY}&prettyPrint=false`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      context: { client: INNERTUBE_CLIENT },
      ...body,
    }),
  });
  if (!resp.ok) throw new Error(`YouTube API error: ${resp.status}`);
  return resp.json();
}
