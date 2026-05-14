/**
 * @owner   Xiaohongshu browser adapters.
 * @does    Detects login, risk-control, and rendered-feed state in XHS web pages.
 * @needs   Browser-backed IPage from Uni-CLI runtime.
 * @feeds   xiaohongshu.search and xiaohongshu.trending.
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

export async function fetchXhsFeedItems(page: IPage): Promise<unknown[]> {
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
