/**
 * Douyin collections — list saved collections from the creator center.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "collections",
  description: "List Douyin collections (playlists)",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of results",
    },
  ],
  columns: ["mix_id", "name", "item_count"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const url = `https://creator.douyin.com/web/api/mix/list/?status=0,1,2,3,6&count=${kwargs.limit}&cursor=0&should_query_new_mix=1&device_platform=web&aid=1128`;
    const res = (await browserFetch(p, "GET", url)) as {
      mix_list: Array<{
        mix_id: string;
        mix_name: string;
        item_count: number;
      }>;
    };
    return (res.mix_list ?? []).map((m) => ({
      mix_id: m.mix_id,
      name: m.mix_name,
      item_count: m.item_count,
    }));
  },
});
