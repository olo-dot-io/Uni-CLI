/**
 * @owner   Twitter browser adapters.
 * @does    Detects X/Twitter login and challenge pages in browser fallback flows.
 * @needs   Browser-backed IPage from Uni-CLI runtime.
 * @feeds   twitter.search and twitter.trending.
 * @breaks  X/Twitter copy or route changes can require updating page-state detection.
 */

import type { IPage } from "../../types.js";
import {
  socialAuthError,
  socialChallengeError,
} from "../../social/browser-errors.js";

interface TwitterPageState {
  url: string;
  title: string;
  text: string;
}

async function readTwitterPageState(page: IPage): Promise<TwitterPageState> {
  const raw = await page.evaluate(`
    (() => ({
      url: window.location.href,
      title: document.title || '',
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 2000)
    }))()
  `);
  const state = raw as Partial<TwitterPageState>;
  return {
    url: String(state.url ?? ""),
    title: String(state.title ?? ""),
    text: String(state.text ?? ""),
  };
}

export async function gotoTwitterPage(
  page: IPage,
  url: string,
  command: string,
): Promise<void> {
  try {
    await page.goto(url, { settleMs: 2500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/net::ERR_ABORTED/i.test(message)) throw err;
  }
  await page.wait(2);
  await assertTwitterReadable(page, command);
}

export async function assertTwitterReadable(
  page: IPage,
  command: string,
): Promise<void> {
  const state = await readTwitterPageState(page);
  const haystack = `${state.url}\n${state.title}\n${state.text}`;
  if (
    /captcha|cloudflare|challenge|verify you are human|unusual traffic/i.test(
      haystack,
    )
  ) {
    throw socialChallengeError(
      "twitter",
      command,
      `Twitter/X is showing a challenge page: ${state.title || state.url}`,
    );
  }
  if (
    /\/i\/flow\/login|Sign in to X|Log in to X|登录 X|登录后/i.test(haystack)
  ) {
    throw socialAuthError("twitter", command);
  }
}
