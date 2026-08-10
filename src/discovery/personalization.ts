/**
 * @owner   src/discovery/personalization.ts
 * @does    Classify commands and user intents into stable personalization families.
 * @needs   Command identity, description, category, and authentication metadata.
 * @feeds   list/search/describe, generated catalogs, and discovery ranking.
 * @breaks  Broad noun matching can mislabel public profile or recommendation APIs as personal account data.
 * @invariants A command is personal only when its identity is account-bound or authenticated metadata and wording establish a current-user workflow.
 * @side-effects none.
 * @perf    O(command + description + query length) over fixed token sets.
 * @concurrency pure and reentrant.
 * @test    tests/unit/discovery-personalization.test.ts
 * @stability Public discovery metadata.
 * @since   2026-08-10
 */

export type PersonalizationFamily =
  | "account"
  | "feed"
  | "library"
  | "network"
  | "activity";

export interface PersonalizationCommandInput {
  command: string;
  description?: string;
  category?: string;
  auth: "required" | "optional" | "none";
}

const ACCOUNT_COMMANDS = new Set([
  "account",
  "me",
  "my-account",
  "native-me",
  "whoami",
]);

const FEED_COMMANDS = new Set([
  "feed",
  "for-you",
  "frontpage",
  "home",
  "recommend",
  "recommendations",
  "suggested",
  "timeline",
]);

const LIBRARY_COMMANDS = new Set([
  "bookmark-folder",
  "bookmark-folders",
  "bookmarks",
  "collection",
  "collections",
  "favorite",
  "favorites",
  "history",
  "later",
  "likes",
  "marks",
  "native-favorite-items",
  "native-favorite-lists",
  "native-favorites-recent",
  "notebooks",
  "play-liked",
  "playlists",
  "saved",
  "shelf",
  "subscriptions",
  "upvoted",
  "watch-later",
]);

const NETWORK_COMMANDS = new Set([
  "connections",
  "following",
  "friends",
  "subscriptions",
]);

const ACTIVITY_COMMANDS = new Set([
  "activity",
  "inbox",
  "mentions",
  "messages",
  "notifications",
  "orders",
]);

const PERSONAL_DESCRIPTION =
  /\b(your|my|logged[- ]in|authenticated|current user|home feed|for[- ]you)\b|我的|当前用户|已登录|个性化/u;

function normalizedCommand(command: string): string {
  return command.normalize("NFKC").toLowerCase().replace(/_/g, "-");
}

/**
 * Return one stable family for a genuinely current-user command. Account and
 * activity identities are intrinsically personal. Other families require an
 * authenticated route or explicit current-user wording.
 */
export function classifyPersonalization(
  input: PersonalizationCommandInput,
): PersonalizationFamily | undefined {
  const command = normalizedCommand(input.command);
  const description = (input.description ?? "").normalize("NFKC").toLowerCase();
  const accountBound =
    input.auth !== "none" || PERSONAL_DESCRIPTION.test(description);

  if (ACCOUNT_COMMANDS.has(command)) return "account";
  if (ACTIVITY_COMMANDS.has(command)) return "activity";
  if (accountBound && LIBRARY_COMMANDS.has(command)) return "library";
  if (accountBound && NETWORK_COMMANDS.has(command)) return "network";
  if (
    FEED_COMMANDS.has(command) &&
    (accountBound || input.category === "social")
  ) {
    return "feed";
  }
  return undefined;
}

const INTENT_TERMS: Readonly<
  Record<PersonalizationFamily, ReadonlySet<string>>
> = {
  account: new Set([
    "account",
    "me",
    "profile",
    "whoami",
    "账户",
    "账号",
    "我的",
  ]),
  feed: new Set([
    "feed",
    "for-you",
    "home",
    "personalized",
    "personalised",
    "recommend",
    "recommendation",
    "recommendations",
    "suggested",
    "timeline",
    "个性化",
    "推荐",
    "首页",
    "时间线",
  ]),
  library: new Set([
    "bookmark",
    "bookmarks",
    "collection",
    "collections",
    "favorite",
    "favorites",
    "history",
    "later",
    "library",
    "liked",
    "likes",
    "playlist",
    "playlists",
    "saved",
    "shelf",
    "watch-later",
    "收藏",
    "历史",
    "稍后看",
    "书架",
  ]),
  network: new Set([
    "connections",
    "following",
    "friends",
    "subscriptions",
    "关注",
    "好友",
    "订阅",
  ]),
  activity: new Set([
    "activity",
    "inbox",
    "mentions",
    "messages",
    "notifications",
    "orders",
    "收件箱",
    "提及",
    "消息",
    "通知",
    "订单",
  ]),
};

export function personalizationIntentFamilies(
  terms: ReadonlySet<string>,
): PersonalizationFamily[] {
  const families: PersonalizationFamily[] = [];
  for (const family of Object.keys(INTENT_TERMS) as PersonalizationFamily[]) {
    if ([...INTENT_TERMS[family]].some((term) => terms.has(term))) {
      families.push(family);
    }
  }
  return families;
}
