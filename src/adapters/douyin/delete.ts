/**
 * Douyin delete — delete a video via the creator center API.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "delete",
  description: "Delete a Douyin video",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "aweme_id",
      required: true,
      positional: true,
      description: "Video aweme_id",
    },
  ],
  columns: ["status"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const url =
      "https://creator.douyin.com/web/api/media/aweme/delete/?aid=1128";
    await browserFetch(p, "POST", url, {
      body: { aweme_id: kwargs.aweme_id },
    });
    return [{ status: `Deleted ${kwargs.aweme_id}` }];
  },
});
