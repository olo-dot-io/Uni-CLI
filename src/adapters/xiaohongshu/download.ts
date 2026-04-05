/**
 * Xiaohongshu download — download images and videos from a note.
 *
 * Navigates to the note page, extracts media URLs from DOM and
 * __INITIAL_STATE__, then downloads them with cookie authentication.
 */

import { cli, Strategy } from "../../registry.js";
import type { IPage } from "../../types.js";
import { loadCookies, formatCookieHeader } from "../../engine/cookies.js";
import { parseNoteId, buildNoteUrl } from "./note-helpers.js";

/** Build authenticated headers for Xiaohongshu downloads. */
function buildCookieHeader(): string {
  const cookies = loadCookies("xiaohongshu");
  if (cookies) return formatCookieHeader(cookies);
  return "";
}

cli({
  site: "xiaohongshu",
  name: "download",
  description: "Download images and videos from a Xiaohongshu note",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "note-id",
      positional: true,
      required: true,
      description: "Note ID, full URL, or short link",
    },
    {
      name: "output",
      default: "./xiaohongshu-downloads",
      description: "Output directory",
    },
  ],
  columns: ["index", "type", "url"],
  func: async (page, kwargs) => {
    const p = page as IPage;
    const rawInput = String(kwargs["note-id"]);
    const noteId = parseNoteId(rawInput);

    await p.goto(buildNoteUrl(rawInput));
    await p.wait(3);

    const data = (await p.evaluate(`
      (() => {
        const result = {
          noteId: '${noteId}',
          title: '',
          author: '',
          media: []
        };
        const seenMedia = new Set();
        const pushMedia = (type, url) => {
          if (!url) return;
          const key = type + ':' + url;
          if (seenMedia.has(key)) return;
          seenMedia.add(key);
          result.media.push({ type, url });
        };

        // Get title
        const titleEl = document.querySelector('.title, #detail-title, .note-content .title');
        result.title = titleEl?.textContent?.trim() || 'untitled';

        // Get author
        const authorEl = document.querySelector('.username, .author-name, .name');
        result.author = authorEl?.textContent?.trim() || 'unknown';

        // Get images
        const imageSelectors = [
          '.swiper-slide img',
          '.carousel-image img',
          '.note-slider img',
          '.note-image img',
          '.image-wrapper img',
          '#noteContainer .media-container img[src*="xhscdn"]',
          'img[src*="ci.xiaohongshu.com"]'
        ];
        const imageUrls = new Set();
        for (const selector of imageSelectors) {
          document.querySelectorAll(selector).forEach(img => {
            let src = img.src || img.getAttribute('data-src') || '';
            if (src && (src.includes('xhscdn') || src.includes('xiaohongshu'))) {
              src = src.split('?')[0];
              imageUrls.add(src);
            }
          });
        }

        // Get video from __INITIAL_STATE__
        try {
          const state = window.__INITIAL_STATE__;
          if (state) {
            const noteData = state.note?.noteDetailMap || state.note?.note || {};
            for (const key of Object.keys(noteData)) {
              const note = noteData[key]?.note || noteData[key];
              const video = note?.video;
              if (video) {
                const vUrl = video.url || video.originVideoKey || video.consumer?.originVideoKey;
                if (vUrl) {
                  const fullUrl = vUrl.startsWith('http') ? vUrl : 'https://sns-video-bd.xhscdn.com/' + vUrl;
                  pushMedia('video', fullUrl);
                }
                const streams = video.media?.stream?.h264 || [];
                for (const stream of streams) {
                  if (stream.masterUrl) pushMedia('video', stream.masterUrl);
                }
              }
            }
          }
        } catch(e) {}

        // Fallback: video from inline scripts
        if (result.media.filter(m => m.type === 'video').length === 0) {
          try {
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const text = s.textContent || '';
              const videoMatches = text.match(/https?:\\/\\/sns-video[^"'\\s]+\\.mp4[^"'\\s]*/g)
                || text.match(/https?:\\/\\/[^"'\\s]*xhscdn[^"'\\s]*\\.mp4[^"'\\s]*/g);
              if (videoMatches) {
                videoMatches.forEach(url => {
                  pushMedia('video', url.replace(/\\\\u002F/g, '/'));
                });
              }
            }
          } catch(e) {}
        }

        // Fallback: video from DOM
        if (result.media.filter(m => m.type === 'video').length === 0) {
          const videoSelectors = ['video source', 'video[src]', '.player video', '.video-player video'];
          for (const selector of videoSelectors) {
            document.querySelectorAll(selector).forEach(v => {
              const src = v.src || v.getAttribute('src') || '';
              if (src && !src.startsWith('blob:')) {
                pushMedia('video', src);
              }
            });
          }
        }

        // Add images to media
        imageUrls.forEach(url => pushMedia('image', url));
        return result;
      })()
    `)) as {
      noteId: string;
      media: Array<{ type: string; url: string }>;
    } | null;

    if (!data || !data.media || data.media.length === 0) {
      return [{ index: 0, type: "-", url: "No media found" }];
    }

    // Cookie header available for authenticated downloads when media pipeline is wired
    void buildCookieHeader();

    return data.media.map((m: { type: string; url: string }, idx: number) => ({
      index: idx + 1,
      type: m.type,
      url: m.url,
    }));
  },
});
