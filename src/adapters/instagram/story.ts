/**
 * Instagram story — publish a story image or video via browser UI.
 *
 * Requires an active Instagram login session in the browser.
 */

import { cli } from "../../registry.js";
import { Strategy } from "../../types.js";
import type { IPage } from "../../types.js";

cli({
  site: "instagram",
  name: "story",
  description: "Post a single Instagram story image or video",
  domain: "www.instagram.com",
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: "media",
      required: true,
      description: "Path to story image or video file",
    },
  ],
  columns: ["status", "detail"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const media = String(kwargs.media ?? "").trim();

    if (!media) {
      throw new Error('Argument "media" is required');
    }

    await p.goto("https://www.instagram.com/");

    // Open story composer
    const result = (await p.evaluate(`
      (() => {
        // Look for the "Your story" button or profile picture ring in the stories tray
        const storyLinks = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
        const storyBtn = storyLinks.find(el => {
          const text = ((el.textContent || '') + ' ' + (el.getAttribute?.('aria-label') || '')).trim().toLowerCase();
          return text.includes('your story') || text.includes('你的快拍') || text.includes('add story');
        });
        if (storyBtn) {
          storyBtn.click();
          return { ok: true };
        }
        return { ok: false, reason: 'Story button not found' };
      })()
    `)) as { ok: boolean; reason?: string };

    if (!result?.ok) {
      throw new Error(result?.reason ?? "Could not open story composer");
    }

    await p.setFileInput('input[type="file"]', [media]);

    return [
      {
        status: "Upload initiated",
        detail: "Story media uploaded to composer",
      },
    ];
  },
});
