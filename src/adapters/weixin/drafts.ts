import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { intArg, js, str } from "../_shared/browser-tools.js";

const DRAFTS =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=list";
const NEW_DRAFT =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10";

cli({
  site: "weixin",
  name: "drafts",
  description: "List WeChat Official Account article drafts",
  domain: "mp.weixin.qq.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "limit", type: "int", default: 20 }],
  columns: ["title", "updated", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const limit = intArg(kwargs.limit, 20, 100);
    await p.goto(DRAFTS, { settleMs: 3000 });
    const rows = await p.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.weui-desktop-card, .appmsg, [class*="draft"], li')];
      return cards.map((card) => {
        const link = card.querySelector('a[href]');
        return {
          title: (card.querySelector('[class*="title"], .appmsg_title, a[href]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          updated: (card.querySelector('[class*="time"], [class*="date"]')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          url: link ? new URL(link.getAttribute('href') || '', location.href).href : ''
        };
      }).filter((row) => row.title).slice(0, ${js(limit)});
    })()`);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  },
});

cli({
  site: "weixin",
  name: "create-draft",
  description: "Create a WeChat Official Account article draft",
  domain: "mp.weixin.qq.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "content", type: "str", required: true, positional: true },
    { name: "title", type: "str", required: true },
    { name: "author", type: "str", required: false },
    { name: "summary", type: "str", required: false },
    { name: "cover_image", type: "str", required: false },
  ],
  columns: ["ok", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(NEW_DRAFT, { settleMs: 3000 });
    await p.evaluate(`(() => {
      const set = (selector, value) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        node.focus?.();
        if ('value' in node) node.value = value;
        else node.textContent = value;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      set('input[placeholder*="标题"], #title, [name="title"]', ${js(str(kwargs.title))});
      set('input[placeholder*="作者"], [name="author"]', ${js(str(kwargs.author))});
      set('textarea[placeholder*="摘要"], [name="digest"]', ${js(str(kwargs.summary))});
      set('[contenteditable="true"], iframe body, textarea', ${js(str(kwargs.content))});
    })()`);
    return [{ ok: true, url: await p.url() }];
  },
});
