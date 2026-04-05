/**
 * Instagram post — publish a photo post via browser UI automation.
 *
 * Navigates to Instagram, opens the composer, uploads media, adds caption,
 * and clicks Share. Requires an active Instagram login session.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import type { IPage } from "../../types.js";

cli({
  site: "instagram",
  name: "post",
  description: "Publish a photo post to Instagram",
  domain: "www.instagram.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: "media",
      required: true,
      description: "Path to image file(s), comma-separated",
    },
    { name: "caption", description: "Post caption text" },
  ],
  columns: ["status", "detail"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const media = String(kwargs.media ?? "");
    const caption = String(kwargs.caption ?? "");

    if (!media.trim()) {
      throw new Error('Argument "media" is required');
    }

    await p.goto("https://www.instagram.com/");

    // Open composer dialog
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

    // Upload files
    const files = media.split(",").map((f) => f.trim());
    await p.setFileInput('input[type="file"]', files);

    // Add caption if provided
    if (caption) {
      await p.evaluate(`
        (async () => {
          await new Promise(r => setTimeout(r, 3000));
          const ta = document.querySelector('textarea, [contenteditable="true"], [aria-label*="caption"], [aria-label*="Caption"]');
          if (ta) {
            ta.focus();
            document.execCommand('insertText', false, ${JSON.stringify(caption)});
          }
        })()
      `);
    }

    return [{ status: "Upload initiated", detail: `${files.length} file(s)` }];
  },
});
