import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { boolArg, clickFirst, js, str } from "../_shared/browser-tools.js";

function targetUrl(target: string): string {
  if (target.startsWith("http")) return target;
  const [kind, a, b] = target.split(":");
  if (kind === "question") return `https://www.zhihu.com/question/${a}`;
  if (kind === "answer")
    return `https://www.zhihu.com/question/${a}/answer/${b}`;
  if (kind === "article") return `https://zhuanlan.zhihu.com/p/${a}`;
  if (kind === "user") return `https://www.zhihu.com/people/${a}`;
  return `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(target)}`;
}

function requireExecute(kwargs: Record<string, unknown>): void {
  if (!boolArg(kwargs.execute)) {
    throw new Error("Pass --execute to perform this Zhihu write action");
  }
}

cli({
  site: "zhihu",
  name: "follow",
  description: "Follow a Zhihu user or question",
  domain: "zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "target", type: "str", required: true, positional: true },
    { name: "execute", type: "bool", default: false },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    requireExecute(kwargs);
    const p = page as IPage;
    await p.goto(targetUrl(str(kwargs.target)), { settleMs: 2500 });
    const selector = await clickFirst(p, [
      "button.FollowButton",
      "button[aria-label*='关注']",
      "button:has(.Zi--Follow)",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});

cli({
  site: "zhihu",
  name: "like",
  description: "Like a Zhihu answer or article",
  domain: "zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "target", type: "str", required: true, positional: true },
    { name: "execute", type: "bool", default: false },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    requireExecute(kwargs);
    const p = page as IPage;
    await p.goto(targetUrl(str(kwargs.target)), { settleMs: 2500 });
    const selector = await clickFirst(p, [
      "button.VoteButton--up",
      "button[aria-label*='赞同']",
      "button[aria-label*='喜欢']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});

cli({
  site: "zhihu",
  name: "favorite",
  description: "Favorite a Zhihu answer or article into an existing collection",
  domain: "zhihu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "target", type: "str", required: true, positional: true },
    { name: "collection", type: "str", required: false },
    { name: "collection_id", type: "str", required: false },
    { name: "execute", type: "bool", default: false },
  ],
  columns: ["ok", "selector", "url"],
  func: async (page, kwargs) => {
    requireExecute(kwargs);
    const p = page as IPage;
    await p.goto(targetUrl(str(kwargs.target)), { settleMs: 2500 });
    await clickFirst(p, [
      "button[aria-label*='收藏']",
      "button:has(.Zi--Star)",
      ".ContentItem-actions button",
    ]);
    await p.wait(0.8);
    if (kwargs.collection) {
      await p.evaluate(`(() => {
        const name = ${js(str(kwargs.collection))};
        const nodes = [...document.querySelectorAll('button, label, div')];
        const node = nodes.find((el) => (el.textContent || '').includes(name));
        if (node) node.click();
      })()`);
    }
    const selector = await clickFirst(p, [
      "button.Button--primary",
      "button[aria-label*='确认']",
      "button[aria-label*='完成']",
    ]);
    return [{ ok: selector !== null, selector, url: await p.url() }];
  },
});
