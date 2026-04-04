/**
 * Jike comment — browser UI automation.
 *
 * Navigates to post detail page, fills the comment input,
 * and clicks the submit button.
 */

import { cli, Strategy } from "../../registry.js";

cli({
  site: "jike",
  name: "comment",
  description: "Comment on a Jike post",
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
      required: true,
      positional: true,
      description: "Comment text",
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

    // Fill comment input
    const inputResult = (await p.evaluate(`(async () => {
      try {
        const textToInsert = ${JSON.stringify(kwargs.text)};
        const editor =
          document.querySelector('[class*="_comment_"] [contenteditable="true"]') ||
          document.querySelector('[contenteditable="true"]');
        if (editor) {
          editor.focus();
          const dt = new DataTransfer();
          dt.setData('text/plain', textToInsert);
          editor.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
          await new Promise(r => setTimeout(r, 800));
          if (editor.textContent?.length > 0) {
            return { ok: true };
          }
        }

        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          const ph = ta.getAttribute('placeholder') || '';
          if (ph.includes('评论') || ph.includes('回复') || ph.includes('说点什么')) {
            ta.focus();
            const setter = Object.getOwnPropertyDescriptor(
              HTMLTextAreaElement.prototype, 'value'
            )?.set;
            setter?.call(ta, textToInsert);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 500));
            return { ok: true };
          }
        }

        if (textareas.length > 0) {
          const ta = textareas[0];
          ta.focus();
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype, 'value'
          )?.set;
          setter?.call(ta, textToInsert);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 500));
          return { ok: true };
        }

        return { ok: false, message: 'Comment input not found' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message?: string };

    if (!inputResult.ok) {
      return [{ status: "failed", message: inputResult.message ?? "" }];
    }

    // Click submit button
    const submitResult = (await p.evaluate(`(async () => {
      try {
        await new Promise(r => setTimeout(r, 500));
        const btns = Array.from(document.querySelectorAll('button')).filter(btn => {
          const text = btn.textContent?.trim() || '';
          return (text === '回复' || text === '发布' || text === '发送' || text === '评论') && !btn.disabled;
        });
        if (btns.length === 0) {
          return { ok: false, message: 'Submit button not found or disabled' };
        }
        btns[0].click();
        return { ok: true, message: 'Comment posted' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message: string };

    if (submitResult.ok) await p.wait(3);

    return [
      {
        status: submitResult.ok ? "success" : "failed",
        message: submitResult.message,
      },
    ];
  },
});
