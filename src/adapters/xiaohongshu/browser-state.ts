/**
 * @owner   Xiaohongshu browser adapters.
 * @does    Detects login, risk-control, and rendered-feed state in XHS web pages.
 * @needs   Browser-backed IPage from Uni-CLI runtime.
 * @feeds   xiaohongshu.feed, xiaohongshu.search, and xiaohongshu.trending.
 * @breaks  XHS copy or route changes can require updating page-state detection.
 */

import type { IPage } from "../../types.js";
import {
  socialAuthError,
  socialChallengeError,
} from "../../social/browser-errors.js";

interface XhsPageState {
  url: string;
  title: string;
  text: string;
}

export async function readXhsPageState(page: IPage): Promise<XhsPageState> {
  const raw = await page.evaluate(`
    (() => ({
      url: window.location.href,
      title: document.title || '',
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 2000)
    }))()
  `);
  const state = raw as Partial<XhsPageState>;
  return {
    url: String(state.url ?? ""),
    title: String(state.title ?? ""),
    text: String(state.text ?? ""),
  };
}

export function assertXhsReadableState(
  command: string,
  state: XhsPageState,
): void {
  const haystack = `${state.url}\n${state.title}\n${state.text}`;
  if (
    /website-login\/error|安全限制|IP存在风险|风险|风控|安全验证|验证码|人机验证|verify|captcha/i.test(
      haystack,
    )
  ) {
    throw socialChallengeError(
      "xiaohongshu",
      command,
      `Xiaohongshu is showing a risk-control or verification page: ${state.title || state.url}`,
    );
  }
  if (/登录后查看|登录后|请先登录|login/i.test(haystack)) {
    throw socialAuthError("xiaohongshu", command);
  }
}

export async function assertXhsReadable(
  page: IPage,
  command: string,
): Promise<void> {
  assertXhsReadableState(command, await readXhsPageState(page));
}

async function fetchXhsStoreFeedItems(page: IPage): Promise<unknown[]> {
  const raw = await page.evaluate(`
    (async () => {
      const app = document.querySelector('#app')?.__vue_app__;
      if (!app) throw new Error('Xiaohongshu Vue app not found');
      const pinia = app.config?.globalProperties?.$pinia;
      if (!pinia || !pinia._s?.has('feed')) throw new Error('Xiaohongshu feed store not found');
      const store = pinia._s.get('feed');
      const captured = [];
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        try {
          const url = String(args[0]?.url || args[0] || '');
          if (/homefeed|feed/i.test(url)) {
            captured.push(await response.clone().json());
          }
        } catch {}
        return response;
      };
      try {
        await store.fetchFeeds();
      } finally {
        window.fetch = originalFetch;
      }
      const payload = captured.find((item) => item?.data?.items?.length) || captured[0];
      return payload?.data?.items || [];
    })()
  `);
  return Array.isArray(raw) ? raw : [];
}

export async function fetchXhsVisibleFeedItems(
  page: IPage,
): Promise<unknown[]> {
  const raw = await page.evaluate(`
    (() => {
      const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const normalizeUrl = (href) => {
        if (!href) return '';
        if (href.startsWith('http://') || href.startsWith('https://')) return href;
        if (href.startsWith('/')) return 'https://www.xiaohongshu.com' + href;
        return '';
      };
      const noteIdFromUrl = (url) => {
        const match = url.match(/\\/(?:explore|search_result|note)\\/([^?#/]+)/i);
        return match ? match[1] : '';
      };
      const rows = [];
      const seen = new Set();
      document.querySelectorAll('section.note-item, .note-item').forEach((el) => {
        const link =
          el.querySelector('a[href*="/explore/"]') ||
          el.querySelector('a[href*="/search_result/"]') ||
          el.querySelector('a[href*="/note/"]');
        const url = normalizeUrl(link?.getAttribute('href') || '');
        const id = noteIdFromUrl(url);
        if (!id || seen.has(id)) return;
        seen.add(id);

        const titleEl = el.querySelector('.title, .note-title, a.title, .footer .title span');
        const authorEl = el.querySelector('a.author .name, .name, .author-name, .nick-name, a.author');
        const likesEl = el.querySelector('.count, .like-count, .like-wrapper .count');
        const isVideo =
          !!el.querySelector('video, .play-icon, .video-icon') ||
          /视频/.test(cleanText(el.textContent));

        rows.push({
          id,
          note_card: {
            display_title: cleanText(titleEl?.textContent || link?.textContent || ''),
            type: isVideo ? 'video' : 'normal',
            user: { nickname: cleanText(authorEl?.textContent || '') },
            interact_info: { liked_count: cleanText(likesEl?.textContent || '0') },
          },
        });
      });
      return rows;
    })()
  `);
  return Array.isArray(raw) ? raw : [];
}

export async function fetchXhsFeedItems(page: IPage): Promise<unknown[]> {
  const storeItems = await fetchXhsStoreFeedItems(page).catch(() => []);
  if (storeItems.length > 0) return storeItems;
  return fetchXhsVisibleFeedItems(page);
}
