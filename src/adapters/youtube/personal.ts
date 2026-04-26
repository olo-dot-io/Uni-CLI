import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, str } from "../_shared/browser-tools.js";

const HOME = "https://www.youtube.com";

async function extractVideos(
  page: IPage,
  url: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await page.goto(url, { settleMs: 2200 });
  const rows = (await page.evaluate(`(() => {
    const anchors = [...document.querySelectorAll('a#video-title, a.yt-simple-endpoint[href*="/watch"], ytd-rich-item-renderer a[href*="/watch"]')];
    const seen = new Set();
    return anchors.map((a) => {
      const href = a.getAttribute('href') || '';
      const url = new URL(href, location.href).href;
      if (!url.includes('/watch') || seen.has(url)) return null;
      seen.add(url);
      const root = a.closest('ytd-video-renderer, ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer') || a.parentElement;
      return {
        title: (a.getAttribute('title') || a.textContent || '').trim(),
        channel: (root?.querySelector('#channel-name, ytd-channel-name')?.textContent || '').trim(),
        meta: (root?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        url
      };
    }).filter(Boolean);
  })()`)) as Record<string, unknown>[];
  return rows.slice(0, limit);
}

async function toggleVideoAction(
  page: IPage,
  target: string,
  selectors: readonly string[],
): Promise<Record<string, unknown>[]> {
  const url = target.startsWith("http")
    ? target
    : `${HOME}/watch?v=${encodeURIComponent(target)}`;
  await page.goto(url, { settleMs: 2200 });
  const selector = await clickFirst(page, selectors);
  return [{ ok: selector !== null, selector, url: await page.url() }];
}

cli({
  site: "youtube",
  name: "feed",
  description: "Read YouTube homepage recommended videos",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "channel", "url"],
  func: async (page, kwargs) =>
    extractVideos(page as IPage, HOME, intArg(kwargs.limit, 20, 100)),
});

cli({
  site: "youtube",
  name: "history",
  description: "Read YouTube watch history",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "channel", "url"],
  func: async (page, kwargs) =>
    extractVideos(
      page as IPage,
      `${HOME}/feed/history`,
      intArg(kwargs.limit, 20, 100),
    ),
});

cli({
  site: "youtube",
  name: "watch-later",
  description: "Read YouTube Watch Later queue",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "channel", "url"],
  func: async (page, kwargs) =>
    extractVideos(
      page as IPage,
      `${HOME}/playlist?list=WL`,
      intArg(kwargs.limit, 20, 100),
    ),
});

cli({
  site: "youtube",
  name: "subscriptions",
  description: "List YouTube subscribed channels",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 50 }],
  columns: ["title", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(`${HOME}/feed/channels`, { settleMs: 2200 });
    const limit = intArg(kwargs.limit, 50, 200);
    const rows = (await p.evaluate(`(() => {
      const links = [...document.querySelectorAll('a[href^="/channel/"], a[href^="/@"]')];
      const seen = new Set();
      return links.map((a) => {
        const url = new URL(a.getAttribute('href') || '', location.href).href;
        if (seen.has(url)) return null;
        seen.add(url);
        return { title: (a.textContent || a.getAttribute('title') || '').trim(), url };
      }).filter((row) => row && row.title);
    })()`)) as Record<string, unknown>[];
    return rows.slice(0, limit);
  },
});

cli({
  site: "youtube",
  name: "like",
  description: "Like a YouTube video in the active browser session",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "video", type: "str", required: true, positional: true }],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) =>
    toggleVideoAction(page as IPage, str(kwargs.video), [
      "like-button-view-model button",
      "ytd-toggle-button-renderer:first-of-type button",
      "button[aria-label*='like']",
      "button[aria-label*='喜欢']",
    ]),
});

cli({
  site: "youtube",
  name: "unlike",
  description: "Remove a YouTube video like in the active browser session",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "video", type: "str", required: true, positional: true }],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) =>
    toggleVideoAction(page as IPage, str(kwargs.video), [
      "like-button-view-model button",
      "ytd-toggle-button-renderer:first-of-type button",
      "button[aria-pressed='true'][aria-label*='like']",
      "button[aria-label*='不喜欢']",
    ]),
});

cli({
  site: "youtube",
  name: "subscribe",
  description: "Subscribe to a YouTube channel",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "channel", type: "str", required: true, positional: true }],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const channel = str(kwargs.channel);
    const url = channel.startsWith("http")
      ? channel
      : channel.startsWith("@")
        ? `${HOME}/${channel}`
        : `${HOME}/channel/${encodeURIComponent(channel)}`;
    await p.goto(url, { settleMs: 2200 });
    const selector = await clickFirst(p, [
      "ytd-subscribe-button-renderer button",
      "button[aria-label*='Subscribe']",
      "button[aria-label*='订阅']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});

cli({
  site: "youtube",
  name: "unsubscribe",
  description: "Unsubscribe from a YouTube channel",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "channel", type: "str", required: true, positional: true }],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const channel = str(kwargs.channel);
    const url = channel.startsWith("http")
      ? channel
      : channel.startsWith("@")
        ? `${HOME}/${channel}`
        : `${HOME}/channel/${encodeURIComponent(channel)}`;
    await p.goto(url, { settleMs: 2200 });
    const first = await clickFirst(p, [
      "ytd-subscribe-button-renderer button",
      "button[aria-label*='Subscribed']",
      "button[aria-label*='已订阅']",
    ]);
    const confirm = await clickFirst(p, [
      "yt-confirm-dialog-renderer #confirm-button button",
      "tp-yt-paper-dialog button[aria-label*='Unsubscribe']",
      "button[aria-label*='取消订阅']",
    ]);
    return [
      { ok: first !== null, selector: confirm ?? first, url: await p.url() },
    ];
  },
});
