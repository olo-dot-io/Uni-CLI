/**
 * @owner   Auth failure guidance.
 * @does    Builds concrete commands for refreshing browser-backed login state,
 *          and applies the canonical --auth-retry failure annotation so every
 *          command path annotates the error envelope identically.
 * @needs   Site name + optional domain from adapter metadata; AgentError/AgentEnvelope shapes.
 * @feeds   Error envelopes, next_actions, CLI retry messages, dispatch/social --auth-retry.
 * @breaks  Auth failures become vague when platform login URLs or retry commands drift.
 */

import type { InvocationResult } from "../engine/kernel/types.js";

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

/**
 * Annotate a failed invocation after a --auth-retry cookie refresh did NOT
 * recover it: merge the refresh suggestion into the error, attach a re-import
 * remedy, and mirror the error onto the envelope. The single source of this
 * annotation so the dispatch and social command paths stay byte-identical
 * (the envelope fields are the measured IV — both paths must agree).
 *
 * No-ops when there is no error to annotate. Mutates `result` in place; the
 * error/envelope field SHAPE is unchanged (only values are filled).
 */
export function annotateAuthRetryFailure(
  result: Pick<InvocationResult, "error" | "envelope">,
  refreshSuggestion: string | undefined,
  site: string,
): void {
  if (!result.error) return;
  result.error.suggestion = [result.error.suggestion, refreshSuggestion]
    .filter(Boolean)
    .join(" ");
  result.error.remedy = {
    message: refreshSuggestion ?? "Refresh browser login state, then retry.",
    command: `unicli auth import ${site}`,
  };
  result.envelope.error = result.error;
}
