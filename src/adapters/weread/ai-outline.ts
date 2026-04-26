import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { str, visibleText } from "../_shared/browser-tools.js";

cli({
  site: "weread",
  name: "ai-outline",
  description: "Extract WeRead AI outline or visible book outline",
  domain: "weread.qq.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [{ name: "bookId", type: "str", required: true, positional: true }],
  columns: ["bookId", "outline", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const bookId = str(kwargs.bookId);
    await p.goto(
      `https://weread.qq.com/web/reader/${encodeURIComponent(bookId)}`,
      {
        settleMs: 2500,
      },
    );
    await p.evaluate(`(() => {
      const candidates = [...document.querySelectorAll('button, a, span')];
      const node = candidates.find((el) => /AI|大纲|目录|总结/.test(el.textContent || ''));
      if (node) node.click();
    })()`);
    await p.wait(1);
    const text = await visibleText(p);
    return [{ bookId, outline: text.slice(0, 8000), url: await p.url() }];
  },
});
