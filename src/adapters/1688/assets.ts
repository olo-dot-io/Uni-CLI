import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

function offerUrl(value: unknown): string {
  const id = str(value);
  if (id.startsWith("http")) return id;
  return `https://detail.1688.com/offer/${encodeURIComponent(id)}.html`;
}

function safeFileName(value: string, index: number): string {
  const url = new URL(value);
  const raw = basename(url.pathname) || `asset-${index + 1}`;
  const clean = raw.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96);
  return extname(clean) ? clean : `${clean || `asset-${index + 1}`}.bin`;
}

async function extractAssets(
  page: IPage,
  id: unknown,
  limit: number,
): Promise<Record<string, unknown>[]> {
  await page.goto(offerUrl(id), { settleMs: 3000 });
  const rows = (await page.evaluate(`(() => {
    const add = (out, type, node, value, source) => {
      if (!value || /^data:/.test(value)) return;
      try {
        const url = new URL(value, location.href).href;
        if (!/^https?:/.test(url)) return;
        out.push({
          type,
          url,
          source,
          alt: (node.getAttribute('alt') || node.getAttribute('title') || '').trim()
        });
      } catch {}
    };
    const out = [];
    for (const img of document.querySelectorAll('img')) {
      add(out, 'image', img, img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src'), 'dom');
    }
    for (const video of document.querySelectorAll('video, source')) {
      add(out, 'video', video, video.currentSrc || video.src || video.getAttribute('data-src'), 'dom');
    }
    const seen = new Set();
    return out.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    }).slice(0, ${js(limit)});
  })()`)) as Record<string, unknown>[];
  return rows;
}

cli({
  site: "1688",
  name: "assets",
  description: "Extract visible product media assets from a 1688 item page",
  domain: "1688.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 80 },
  ],
  columns: ["type", "url", "alt"],
  func: async (page, kwargs) =>
    extractAssets(page as IPage, kwargs.id, intArg(kwargs.limit, 80, 300)),
});

cli({
  site: "1688",
  name: "download",
  description: "Download visible product media assets from a 1688 item page",
  domain: "1688.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "id", type: "str", required: true, positional: true },
    { name: "output", type: "str", default: "./1688-downloads" },
    { name: "limit", type: "int", default: 50 },
  ],
  columns: ["path", "url", "status"],
  func: async (page, kwargs) => {
    const output = str(kwargs.output, "./1688-downloads");
    const assets = await extractAssets(
      page as IPage,
      kwargs.id,
      intArg(kwargs.limit, 50, 200),
    );
    await mkdir(output, { recursive: true });
    const rows: Record<string, unknown>[] = [];
    for (const [index, asset] of assets.entries()) {
      const url = str(asset.url);
      const path = join(output, safeFileName(url, index));
      try {
        const response = await fetch(url);
        const bytes = Buffer.from(await response.arrayBuffer());
        await writeFile(path, bytes);
        rows.push({ path, url, status: response.status, bytes: bytes.length });
      } catch (err) {
        rows.push({
          path,
          url,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return rows;
  },
});
