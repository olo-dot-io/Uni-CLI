/**
 * Instagram reel — publish a reel video via browser UI.
 *
 * Requires an active Instagram login session in the browser.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import type { IPage } from "../../types.js";

cli({
  site: "instagram",
  name: "reel",
  description: "Post a reel video to Instagram",
  domain: "www.instagram.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: "video",
      required: true,
      description: "Path to video file (.mp4)",
    },
    { name: "caption", description: "Reel caption text" },
  ],
  columns: ["status", "detail"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const video = String(kwargs.video ?? "").trim();
    const caption = String(kwargs.caption ?? "");

    if (!video) {
      throw new Error('Argument "video" is required');
    }

    await p.goto("https://www.instagram.com/");

    // Open composer
    const composerResult = (await p.evaluate(`
      (() => {
        const labels = ['Create', 'New post', 'Post', '创建', '新帖子'];
        const nodes = Array.from(document.querySelectorAll('a, button, div[role="button"], svg[aria-label], [aria-label]'));
        for (const node of nodes) {
          const text = ((node.textContent || '') + ' ' + (node.getAttribute?.('aria-label') || '')).trim();
          if (labels.some(label => text.toLowerCase().includes(label.toLowerCase()))) {
            const clickable = node.closest('a, button, div[role="button"]') || node;
            if (clickable instanceof HTMLElement) {
              clickable.click();
              return { ok: true };
            }
          }
        }
        return { ok: false, reason: 'Composer button not found' };
      })()
    `)) as { ok: boolean; reason?: string };

    if (!composerResult?.ok) {
      throw new Error(
        composerResult?.reason ?? "Could not open Instagram composer",
      );
    }

    await p.setFileInput('input[type="file"]', [video]);

    if (caption) {
      await p.evaluate(`
        (async () => {
          await new Promise(r => setTimeout(r, 5000));
          const ta = document.querySelector('textarea, [contenteditable="true"], [aria-label*="caption"], [aria-label*="Caption"]');
          if (ta) {
            ta.focus();
            document.execCommand('insertText', false, ${JSON.stringify(caption)});
          }
        })()
      `);
    }

    return [{ status: "Upload initiated", detail: "Reel video uploaded" }];
  },
});
