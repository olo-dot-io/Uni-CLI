/**
 * Douyin drafts — list draft videos from the creator center.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "drafts",
  description: "List Douyin draft videos",
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
  columns: ["aweme_id", "title", "create_time"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const url =
      "https://creator.douyin.com/web/api/media/aweme/draft/?aid=1128";
    const res = (await browserFetch(p, "GET", url)) as {
      aweme_list: Array<{
        aweme_id: string;
        desc: string;
        create_time: number;
      }>;
    };
    const items = (res.aweme_list ?? []).slice(0, kwargs.limit as number);
    return items.map((v) => ({
      aweme_id: v.aweme_id,
      title: v.desc,
      create_time: new Date(v.create_time * 1000).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      }),
    }));
  },
});
