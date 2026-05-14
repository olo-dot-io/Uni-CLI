/**
 * @owner   Auth failure guidance.
 * @does    Builds concrete commands for refreshing browser-backed login state.
 * @needs   Site name and optional domain from adapter metadata.
 * @feeds   Error envelopes, next_actions, and CLI retry messages.
 * @breaks  Auth failures become vague when platform login URLs or retry commands drift.
 */

const SITE_DOMAINS: Record<string, string> = {
  bilibili: "bilibili.com",
  douyin: "douyin.com",
  facebook: "facebook.com",
  instagram: "instagram.com",
  reddit: "reddit.com",
  threads: "threads.net",
  tiktok: "tiktok.com",
  twitter: "x.com",
  weixin: "mp.weixin.qq.com",
  xiaohongshu: "www.xiaohongshu.com",
  youtube: "youtube.com",
  zhihu: "www.zhihu.com",
};

export function authDomainForSite(site: string, domain?: string): string {
  if (domain) return domain;
  return SITE_DOMAINS[site] ?? (site.includes(".") ? site : `${site}.com`);
}

export function authLoginUrl(site: string, domain?: string): string {
  return `https://${authDomainForSite(site, domain)}`;
}

export function authImportCommand(site: string, domain?: string): string {
  return `unicli auth import ${site} --domain ${authDomainForSite(site, domain)}`;
}

export function authRetryCommand(site: string, cmdName: string): string {
  return `unicli --auth-retry ${site} ${cmdName} --args-file <path.json>`;
}

export function authFailureSuggestion(site: string, cmdName: string): string {
  return [
    `Refresh login state with \`${authImportCommand(site)}\`, then retry.`,
    `For one-shot recovery, run \`${authRetryCommand(site, cmdName)}\`.`,
    `If no cookies are found, open \`${authLoginUrl(site)}\` in the browser, sign in, then retry.`,
  ].join(" ");
}

export function challengeFailureSuggestion(
  site: string,
  cmdName: string,
): string {
  return [
    `Open \`${authLoginUrl(site)}\` in the shared browser and complete the login, captcha, or risk-control challenge.`,
    `Then refresh cookies with \`${authImportCommand(site)}\`.`,
    `For one-shot recovery after the browser is clean, run \`${authRetryCommand(site, cmdName)}\`.`,
  ].join(" ");
}
