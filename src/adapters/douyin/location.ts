/**
 * Douyin location — search POI (Point of Interest) locations for video tagging.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { browserFetch } from "./_shared/browser-fetch.js";

cli({
  site: "douyin",
  name: "location",
  description: "Search Douyin POI locations for video tagging",
  domain: "creator.douyin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "query",
      required: true,
      positional: true,
      description: "Location keyword",
    },
    { name: "limit", type: "int", default: 20, description: "Max results" },
  ],
  columns: ["poi_id", "name", "address", "city"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const keyword = encodeURIComponent(String(kwargs.query));
    const limit = Number(kwargs.limit) || 20;
    const url = `https://creator.douyin.com/aweme/v1/life/video_api/search/poi/?keyword=${keyword}&count=${limit}&aid=1128`;
    const res = (await browserFetch(p, "GET", url)) as {
      poi_list: Array<{
        poi_id: string;
        poi_name: string;
        address: string;
        city_name: string;
      }>;
    };
    return (res.poi_list ?? []).map((poi) => ({
      poi_id: poi.poi_id,
      name: poi.poi_name,
      address: poi.address,
      city: poi.city_name,
    }));
  },
});
