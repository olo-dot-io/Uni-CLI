import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { clickFirst, intArg, js, str } from "../_shared/browser-tools.js";

const DRIVE = "https://drive-pc.quark.cn/list#/list/all";

async function openDrive(page: IPage): Promise<void> {
  await page.goto(DRIVE, { settleMs: 1800 });
}

async function driveFetch(
  page: IPage,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  await openDrive(page);
  const result = await page.evaluate(`(async () => {
    const response = await fetch(${js(path)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json;charset=utf-8' },
      body: ${js(JSON.stringify(body))}
    });
    let data = null;
    try { data = await response.json(); } catch {}
    return [{
      ok: response.ok,
      status: response.status,
      data,
      message: data?.message || data?.error || ''
    }];
  })()`);
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

function fidList(value: unknown): string[] {
  return str(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

cli({
  site: "quark",
  name: "mkdir",
  description: "Create a folder in Quark Drive",
  domain: "drive-pc.quark.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "name", type: "str", required: true, positional: true },
    { name: "parent_fid", type: "str", default: "0" },
  ],
  columns: ["ok", "status", "message"],
  func: async (page, kwargs) =>
    driveFetch(page as IPage, "/1/clouddrive/file?fr=pc", {
      pdir_fid: str(kwargs.parent_fid, "0"),
      file_name: str(kwargs.name),
      dir_path: "",
    }),
});

cli({
  site: "quark",
  name: "rename",
  description: "Rename a Quark Drive file or folder",
  domain: "drive-pc.quark.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "fid", type: "str", required: true, positional: true },
    { name: "name", type: "str", required: true },
  ],
  columns: ["ok", "status", "message"],
  func: async (page, kwargs) =>
    driveFetch(page as IPage, "/1/clouddrive/file/rename?fr=pc", {
      fid: str(kwargs.fid),
      file_name: str(kwargs.name),
    }),
});

cli({
  site: "quark",
  name: "rm",
  description: "Delete Quark Drive files or folders by fid list",
  domain: "drive-pc.quark.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "fids", type: "str", required: true, positional: true }],
  columns: ["ok", "status", "message"],
  func: async (page, kwargs) =>
    driveFetch(page as IPage, "/1/clouddrive/file/delete?fr=pc", {
      action_type: 2,
      filelist: fidList(kwargs.fids).map((fid) => ({ fid })),
    }),
});

cli({
  site: "quark",
  name: "mv",
  description: "Move Quark Drive files to a target folder fid",
  domain: "drive-pc.quark.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "fids", type: "str", required: true, positional: true },
    { name: "to_fid", type: "str", required: true },
  ],
  columns: ["ok", "status", "message"],
  func: async (page, kwargs) =>
    driveFetch(page as IPage, "/1/clouddrive/file/move?fr=pc", {
      to_pdir_fid: str(kwargs.to_fid),
      action_type: 1,
      filelist: fidList(kwargs.fids).map((fid) => ({ fid })),
    }),
});

cli({
  site: "quark",
  name: "share-tree",
  description: "Read a Quark share page directory tree",
  domain: "pan.quark.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "url", type: "str", required: true, positional: true },
    { name: "limit", type: "int", default: 100 },
  ],
  columns: ["name", "type", "size"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(str(kwargs.url), { settleMs: 2500 });
    const limit = intArg(kwargs.limit, 100, 500);
    const rows = await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('[class*="file"], [class*="item"], [role="row"]')];
      return cards.map((card) => ({
        name: (card.querySelector('[class*="name"], [title]')?.textContent || card.getAttribute('title') || '').replace(/\\s+/g, ' ').trim(),
        type: /folder|文件夹/.test(card.textContent || '') ? 'folder' : 'file',
        size: (card.querySelector('[class*="size"]')?.textContent || '').trim()
      })).filter((row) => row.name).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});

cli({
  site: "quark",
  name: "save",
  description: "Save a Quark share into the active Drive account",
  domain: "pan.quark.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "url", type: "str", required: true, positional: true },
    { name: "to_fid", type: "str", required: false },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(str(kwargs.url), { settleMs: 2500 });
    const selector = await clickFirst(p, [
      "button[class*='save']",
      "button[aria-label*='保存']",
      "button[title*='保存']",
      "button",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});
