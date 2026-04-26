import { cli, Strategy } from "../../registry.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { USER_AGENT } from "../../constants.js";
import { intArg, str } from "../_shared/browser-tools.js";

async function bilibiliJson(url: string): Promise<Record<string, unknown>> {
  const cookies = loadCookies("bilibili");
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    referer: "https://www.bilibili.com",
    accept: "application/json",
  };
  if (cookies) headers.cookie = formatCookieHeader(cookies);
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Bilibili request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function dataObject(value: Record<string, unknown>): Record<string, unknown> {
  return (value.data ?? {}) as Record<string, unknown>;
}

cli({
  site: "bilibili",
  name: "video",
  description: "Get Bilibili video metadata by BV ID or URL",
  domain: "api.bilibili.com",
  strategy: Strategy.PUBLIC,
  args: [{ name: "bvid", type: "str", required: true, positional: true }],
  columns: ["title", "author", "duration", "views", "bvid"],
  func: async (_page, kwargs) => {
    const input = str(kwargs.bvid);
    const match = /BV[a-zA-Z0-9]+/.exec(input);
    const bvid = match?.[0] ?? input;
    const data = dataObject(
      await bilibiliJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      ),
    );
    const owner = (data.owner ?? {}) as Record<string, unknown>;
    const stat = (data.stat ?? {}) as Record<string, unknown>;
    return [
      {
        title: data.title ?? "",
        author: owner.name ?? "",
        duration: data.duration ?? 0,
        views: stat.view ?? 0,
        likes: stat.like ?? 0,
        bvid: data.bvid ?? bvid,
      },
    ];
  },
});

cli({
  site: "bilibili",
  name: "favorite",
  description: "Read Bilibili favorite folder videos",
  domain: "api.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "fid", type: "str", required: false },
    { name: "limit", type: "int", default: 20 },
  ],
  columns: ["title", "author", "fav_time", "bvid"],
  func: async (_page, kwargs) => {
    const limit = intArg(kwargs.limit, 20, 100);
    let fid = str(kwargs.fid);
    if (!fid) {
      const folders = dataObject(
        await bilibiliJson(
          "https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=0",
        ),
      );
      const list = Array.isArray(folders.list)
        ? (folders.list as Record<string, unknown>[])
        : [];
      fid = str(list[0]?.id);
    }
    if (!fid) throw new Error("No Bilibili favorite folder id found");
    const data = dataObject(
      await bilibiliJson(
        `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(fid)}&ps=${limit}&pn=1`,
      ),
    );
    const medias = Array.isArray(data.medias)
      ? (data.medias as Record<string, unknown>[])
      : [];
    return medias.slice(0, limit).map((item) => {
      const upper = (item.upper ?? {}) as Record<string, unknown>;
      return {
        title: item.title ?? "",
        author: upper.name ?? "",
        fav_time: item.fav_time ?? "",
        bvid: item.bvid ?? "",
      };
    });
  },
});

cli({
  site: "bilibili",
  name: "feed-detail",
  description: "Read a Bilibili dynamic feed item detail",
  domain: "api.bilibili.com",
  strategy: Strategy.COOKIE,
  args: [{ name: "id", type: "str", required: true, positional: true }],
  columns: ["author", "type", "text", "url"],
  func: async (_page, kwargs) => {
    const id = str(kwargs.id).replace(/^https?:\/\/t\.bilibili\.com\//, "");
    const data = dataObject(
      await bilibiliJson(
        `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${encodeURIComponent(id)}`,
      ),
    );
    const item = (data.item ?? data) as Record<string, unknown>;
    const modules = (item.modules ?? {}) as Record<string, unknown>;
    const author = (modules.module_author ?? {}) as Record<string, unknown>;
    const dynamic = (modules.module_dynamic ?? {}) as Record<string, unknown>;
    const desc = (dynamic.desc ?? {}) as Record<string, unknown>;
    return [
      {
        author: author.name ?? "",
        type: item.type ?? "",
        text: desc.text ?? "",
        url: `https://t.bilibili.com/${id}`,
      },
    ];
  },
});
