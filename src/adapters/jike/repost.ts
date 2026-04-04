/**
 * Jike repost — browser UI automation.
 *
 * Opens post detail, clicks repost in action bar, selects "转发动态"
 * from the popover, optionally adds comment text, then confirms.
 */

import { cli, Strategy } from "../../registry.js";

cli({
  site: "jike",
  name: "repost",
  description: "Repost a Jike post",
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
    {
      name: "text",
      positional: true,
      description: "Optional repost comment",
    },
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    const p = page as {
      goto: (url: string) => Promise<void>;
      evaluate: (script: string) => Promise<unknown>;
      wait: (seconds: number) => Promise<void>;
    };

    await p.goto(`https://web.okjike.com/originalPost/${kwargs.id}`);

    // Click the repost button (third child in action bar)
    const clickResult = (await p.evaluate(`(async () => {
      try {
        const actions = document.querySelector('[class*="_actions_"]');
        if (!actions) return { ok: false, message: 'Action bar not found' };
        const children = Array.from(actions.children).filter(c => c.offsetHeight > 0);
        if (!children[2]) return { ok: false, message: 'Repost button not found' };
        children[2].click();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message?: string };

    if (!clickResult.ok) {
      return [{ status: "failed", message: clickResult.message ?? "" }];
    }

    await p.wait(1);

    // Click "转发动态" in popover menu
    const menuResult = (await p.evaluate(`(async () => {
      try {
        const btn = Array.from(document.querySelectorAll('button')).find(
          b => b.textContent?.trim() === '转发动态'
        );
        if (!btn) return { ok: false, message: 'Repost menu item not found' };
        btn.click();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message?: string };

    if (!menuResult.ok) {
      return [{ status: "failed", message: menuResult.message ?? "" }];
    }

    await p.wait(2);

    // Add comment text if provided
    if (kwargs.text) {
      const textResult = (await p.evaluate(`(async () => {
        try {
          const editor = document.querySelector('[contenteditable="true"]');
          if (!editor) return { ok: false, message: 'Comment input not found' };
          editor.focus();
          const dt = new DataTransfer();
          dt.setData('text/plain', ${JSON.stringify(kwargs.text)});
          editor.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
          await new Promise(r => setTimeout(r, 500));
          return { ok: true };
        } catch (e) {
          return { ok: false, message: e.toString() };
        }
      })()`)) as { ok: boolean; message?: string };

      if (!textResult.ok) {
        return [{ status: "failed", message: textResult.message ?? "" }];
      }
    }

    // Click submit button
    const confirmResult = (await p.evaluate(`(async () => {
      try {
        await new Promise(r => setTimeout(r, 500));
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const text = b.textContent?.trim() || '';
          return (text === '发送' || text === '发布') && !b.disabled;
        });
        if (!btn) return { ok: false, message: 'Submit button not found' };
        btn.click();
        return { ok: true, message: 'Reposted successfully' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message: string };

    if (confirmResult.ok) await p.wait(3);

    return [
      {
        status: confirmResult.ok ? "success" : "failed",
        message: confirmResult.message,
      },
    ];
  },
});
