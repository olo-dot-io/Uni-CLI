/**
 * @owner   Mastodon user status adapter.
 * @does    Register a public read command for recent statuses by account handle.
 * @needs   Mastodon-compatible public API endpoints for account lookup and statuses.
 * @feeds   Social research workflows and social capability coverage.
 * @breaks  Instance API drift, blocked public egress, or accounts hidden from public lookup.
 */

import { USER_AGENT } from "../../constants.js";
import { cli, Strategy } from "../../registry.js";

interface MastodonAccount {
  id?: unknown;
  acct?: unknown;
  display_name?: unknown;
}

interface MastodonStatus {
  created_at?: unknown;
  content?: unknown;
  url?: unknown;
  reblogs_count?: unknown;
  favourites_count?: unknown;
  replies_count?: unknown;
  account?: MastodonAccount;
}

export interface MastodonAccountRef {
  acct: string;
  instance: string;
}

export interface MastodonStatusRow {
  rank: number;
  author: string;
  handle: string;
  content: string;
  reblogs: number;
  favorites: number;
  replies: number;
  url: string;
  date: string;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stripHtml(value: unknown): string {
  return cleanString(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeMastodonAccount(
  input: string,
  instanceOverride = "mastodon.social",
): MastodonAccountRef {
  const trimmed = input.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Mastodon account cannot be empty");
  const parts = trimmed.split("@").filter(Boolean);
  if (parts.length > 2) {
    throw new Error(`Invalid Mastodon account: ${input}`);
  }
  const acct = parts[0];
  const instance = parts[1] ?? instanceOverride.trim();
  if (!acct || !instance) {
    throw new Error(`Invalid Mastodon account: ${input}`);
  }
  return { acct, instance };
}

export function mapMastodonStatusRows(
  statuses: MastodonStatus[],
  limit: number,
): MastodonStatusRow[] {
  const rows: Omit<MastodonStatusRow, "rank">[] = [];
  for (const status of statuses) {
    const content = stripHtml(status.content).slice(0, 500);
    if (!content) continue;
    const account = status.account ?? {};
    const handle = cleanString(account.acct);
    rows.push({
      author: cleanString(account.display_name) || handle,
      handle: handle ? `@${handle}` : "",
      content,
      reblogs: numberValue(status.reblogs_count),
      favorites: numberValue(status.favourites_count),
      replies: numberValue(status.replies_count),
      url: cleanString(status.url),
      date: cleanString(status.created_at),
    });
  }
  return rows.slice(0, limit).map((row, index) => ({
    rank: index + 1,
    ...row,
  }));
}

function parseLimit(value: unknown): number {
  const limit = Number(value ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 40) {
    throw new Error(
      `--limit must be an integer between 1 and 40, got ${value}`,
    );
  }
  return limit;
}

async function fetchMastodonJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) {
    const preview = (await response.text()).slice(0, 200);
    throw new Error(`Mastodon HTTP ${response.status} from ${url}: ${preview}`);
  }
  return response.json() as Promise<unknown>;
}

function requireAccountId(account: unknown): string {
  if (!account || typeof account !== "object") {
    throw new Error("Mastodon account lookup returned a non-object response");
  }
  const id = cleanString((account as MastodonAccount).id);
  if (!id) throw new Error("Mastodon account lookup did not return an id");
  return id;
}

cli({
  site: "mastodon",
  name: "statuses",
  description: "Get recent public statuses from a Mastodon account",
  domain: "mastodon.social",
  strategy: Strategy.PUBLIC,
  args: [
    {
      name: "account",
      required: true,
      positional: true,
      description: "Account handle, e.g. gargron@mastodon.social",
    },
    {
      name: "instance",
      type: "str",
      default: "mastodon.social",
      description: "Mastodon instance domain used when account omits one",
    },
    {
      name: "limit",
      type: "int",
      default: 20,
      description: "Number of statuses, 1-40",
    },
  ],
  columns: [
    "rank",
    "author",
    "handle",
    "content",
    "reblogs",
    "favorites",
    "replies",
    "url",
    "date",
  ],
  socialCapabilities: ["read", "user_content", "reactions"],
  func: async (_page, kwargs) => {
    const limit = parseLimit(kwargs.limit);
    const account = normalizeMastodonAccount(
      String(kwargs.account ?? ""),
      String(kwargs.instance ?? "mastodon.social"),
    );
    const origin = `https://${account.instance}`;
    const lookupUrl = new URL("/api/v1/accounts/lookup", origin);
    lookupUrl.searchParams.set("acct", account.acct);
    const lookup = await fetchMastodonJson(lookupUrl.toString());
    const accountId = requireAccountId(lookup);
    const statusesUrl = new URL(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses`,
      origin,
    );
    statusesUrl.searchParams.set("limit", String(limit));
    statusesUrl.searchParams.set("exclude_reblogs", "false");
    statusesUrl.searchParams.set("exclude_replies", "false");
    const statuses = await fetchMastodonJson(statusesUrl.toString());
    if (!Array.isArray(statuses)) {
      throw new Error(
        "Mastodon statuses endpoint returned a non-array response",
      );
    }
    return mapMastodonStatusRows(statuses as MastodonStatus[], limit);
  },
});
