/**
 * Jike create post — browser UI automation.
 *
 * Navigates to web.okjike.com, fills the inline post form,
 * and clicks the submit button.
 */

import { cli, Strategy } from "../../registry.js";

cli({
  site: "jike",
  name: "create",
  description: "Create a Jike post",
  domain: "web.okjike.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "text",
      required: true,
      positional: true,
      description: "Post content",
    },
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    const p = page as {
      goto: (url: string) => Promise<void>;
      evaluate: (script: string) => Promise<unknown>;
      wait: (seconds: number) => Promise<void>;
    };

    await p.goto("https://web.okjike.com");

    const textResult = (await p.evaluate(`(async () => {
      try {
        const textToInsert = ${JSON.stringify(kwargs.text)};
        const form = document.querySelector('[class*="_postForm_"]');
        const editor = form
          ? form.querySelector('[contenteditable="true"]')
          : document.querySelector('[contenteditable="true"]');

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

        const textarea = form
          ? form.querySelector('textarea')
          : document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype, 'value'
          )?.set;
          setter?.call(textarea, textToInsert);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 500));
          return { ok: true };
        }

        return { ok: false, message: 'Post input not found' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message?: string };

    if (!textResult.ok) {
      return [{ status: "failed", message: textResult.message }];
    }

    const submitResult = (await p.evaluate(`(async () => {
      try {
        await new Promise(r => setTimeout(r, 500));
        const candidates = Array.from(document.querySelectorAll('button')).filter(btn => {
          const text = btn.textContent?.trim() || '';
          return (text === '发送' || text === '发布') && !btn.disabled;
        });
        if (candidates.length === 0) {
          return { ok: false, message: 'Submit button not found or disabled' };
        }
        candidates[0].click();
        return { ok: true, message: 'Post created' };
      } catch (e) {
        return { ok: false, message: e.toString() };
      }
    })()`)) as { ok: boolean; message: string };

    if (submitResult.ok) {
      await p.wait(3);
    }

    return [
      {
        status: submitResult.ok ? "success" : "failed",
        message: submitResult.message,
      },
    ];
  },
});
