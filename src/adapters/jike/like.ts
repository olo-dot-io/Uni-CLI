/**
 * Jike like post — browser UI automation.
 *
 * Navigates to the post detail page and clicks the like button.
 */

import { cli, Strategy } from "../../registry.js";
import { throwProviderReportedFailure } from "../_shared/actionable-error.js";

cli({
  site: "jike",
  name: "like",
  description: "Like a Jike post",
  domain: "web.okjike.com",
  strategy: Strategy.COOKIE,
  operation_effect: "account_state",
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

    if (!result.ok) {
      throwProviderReportedFailure(
        result.message,
        "Inspect the Jike like control and current post state before retrying.",
      );
    }
    return [{ status: "success", message: result.message }];
  },
});
