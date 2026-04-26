import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { str, visibleText } from "../_shared/browser-tools.js";

cli({
  site: "jianyu",
  name: "detail",
  description: "Extract Jianyu procurement notice detail evidence",
  domain: "www.jianyu360.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "url", type: "str", required: true, positional: true }],
  columns: ["title", "published_at", "detail_text", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    await p.goto(str(kwargs.url), { settleMs: 2500 });
    const text = await visibleText(p);
    const date = (text.match(/\d{4}[-年.]\d{1,2}[-月.]\d{1,2}/) ?? [""])[0];
    return [
      {
        title: await p.title(),
        published_at: date,
        detail_text: text.slice(0, 8000),
        url: await p.url(),
      },
    ];
  },
});
