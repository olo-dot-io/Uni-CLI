/**
 * Jike like post — browser UI automation.
 *
 * Navigates to the post detail page and clicks the like button.
 */

import { cli, Strategy } from "../../registry.js";

cli({
  site: "jike",
  name: "like",
  description: "Like a Jike post",
  domain: "web.okjike.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "id",
      required: true,
      positional: true,
      description: "Post ID",
    },
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    const p = page as {
      goto: (url: string) => Promise<void>;
      evaluate: (script: string) => Promise<unknown>;
    };

    await p.goto(`https://web.okjike.com/originalPost/${kwargs.id}`);

    const result = (await p.evaluate(`(async () => {
      try {
        const likeBtn = document.querySelector('[class*="_likeButton_"]');
        if (!likeBtn) {
          return { ok: false, message: 'Like button not found' };
        }
        const cls = likeBtn.className || '';
        if (cls.includes('_liked')) {
          return { ok: true, message: 'Already liked' };
        }
        const beforeCls = likeBtn.className;
        likeBtn.click();
        await new Promise(r => setTimeout(r, 1500));
        const afterCls = likeBtn.className;
        if (afterCls !== beforeCls) {
          return { ok: true, message: 'Liked successfully' };
        }
        return { ok: false, message: 'Like status not confirmed' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message: string };

    return [
      {
        status: result.ok ? "success" : "failed",
        message: result.message,
      },
    ];
  },
});
