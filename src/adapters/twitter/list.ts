/**
 * @owner       src/adapters/twitter/list.ts
 * @does        Creates Twitter/X lists, reads list members and list timelines, and adds or removes members in bulk through GraphQL.
 * @needs       X cookies for the signed-in account and the GraphQL client in ./client.ts.
 * @feeds       twitter.list-create, twitter.list-members, twitter.list-add, twitter.list-remove, twitter.list-tweets.
 * @breaks      X response shape drift empties rows; retired query ids are resolved by ./operations.ts.
 * @invariants  list-add and list-remove read the current members first and change only users whose membership differs.
 * @side-effects list-create creates a list; list-add and list-remove change list membership, one user per request.
 * @perf        Membership changes are spaced by --delay seconds; a 429 waits for the rate-limit window to reset.
 * @concurrency One sequential request chain per invocation.
 * @stability   experimental
 * @since       2026-11-02
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { cli, Strategy } from "../../registry.js";
import { boolArg, intArg, str } from "../_shared/browser-tools.js";
import { TWEET_COLUMNS } from "./browser-extraction.js";
import {
  collectTimelineTweets,
  collectTimelineUsers,
  invalidTwitterInput,
  lookupUserId,
  obj,
  sinceArg,
  timelinePages,
  twitterPostFetch,
  USER_COLUMNS,
  withRateLimitWait,
} from "./client.js";

const QUERY_IDS = {
  CreateList: "zdGzorOEOslDL4XEbe2INw",
  ListMembers: "_RDpx--fQKSccuRlGpEIoA",
  ListAddMember: "-Kf1YVC1rNKkPvPFk7YXZw",
  ListRemoveMember: "_2o1-wSMWGFSi5HUscn1Hw",
  ListLatestTweetsTimeline: "dCYL1r8KgXjvgV6t1vtSZA",
};

const LIST_ARG = {
  name: "list",
  type: "str" as const,
  required: true,
  positional: true,
  description: "List id or https://x.com/i/lists/<id> URL",
};

function listIdArg(value: unknown): string {
  const raw = str(value).trim();
  const id =
    /^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/lists\/)?(\d+)(?:[/?#].*)?$/.exec(
      raw,
    )?.[1];
  if (id) return id;
  throw invalidTwitterInput(
    `"${raw}" is not a Twitter/X list id`,
    "Pass the numeric list id or a https://x.com/i/lists/<id> URL.",
  );
}

function listMemberPages(listId: string): AsyncGenerator<unknown[]> {
  return timelinePages(
    "ListMembers",
    QUERY_IDS.ListMembers,
    { listId, count: 100 },
    ["data", "list", "members_timeline", "timeline", "instructions"],
  );
}

function graphqlErrorMessage(data: unknown): string {
  const errors = obj(data).errors;
  return Array.isArray(errors) && errors.length > 0
    ? String(obj(errors[0]).message ?? "")
    : "X returned no list";
}

/** Users from `--users a,@b,123` and `--users-file` (one per line), deduplicated in input order. */
function userTokens(users: unknown, usersFile: unknown): string[] {
  const listed = Array.isArray(users)
    ? users.map(String)
    : typeof users === "string"
      ? users.split(",")
      : [];
  let fromFile: string[] = [];
  if (typeof usersFile === "string" && usersFile) {
    try {
      fromFile = readFileSync(usersFile, "utf-8").split(/\r?\n/);
    } catch (error) {
      throw invalidTwitterInput(
        `cannot read --users-file ${usersFile}: ${error instanceof Error ? error.message : String(error)}`,
        "Pass a readable text file with one handle or user id per line.",
      );
    }
  }
  const tokens = new Map<string, string>();
  for (const raw of [...listed, ...fromFile]) {
    const token = raw.trim();
    if (!token) continue;
    const key = /^\d+$/.test(token)
      ? token
      : `@${token.replace(/^@/, "").toLowerCase()}`;
    if (!tokens.has(key)) tokens.set(key, token);
  }
  if (tokens.size === 0) {
    throw invalidTwitterInput(
      "no users given",
      "Pass --users a,@b,123 or --users-file <path> with one handle or user id per line.",
    );
  }
  return [...tokens.values()];
}

type MembershipStatus =
  "added" | "removed" | "already" | "not-found" | "failed";

interface MembershipRow {
  user: string;
  id: string;
  status: MembershipStatus;
  error: string;
}

/**
 * Brings each user to the requested membership state. Members are read
 * first, handles not among them are resolved with UserByScreenName, and
 * only users whose membership differs get a mutation, `delayMs` apart.
 */
async function changeMembership(
  kwargs: Record<string, unknown>,
  mode: "add" | "remove",
): Promise<MembershipRow[]> {
  const listId = listIdArg(kwargs.list);
  const tokens = userTokens(kwargs.users, kwargs["users-file"]);
  const delaySeconds = Number(kwargs.delay ?? 1.5);
  const delayMs =
    Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds * 1000 : 0;

  const members = await collectTimelineUsers(
    listMemberPages(listId),
    Number.POSITIVE_INFINITY,
  );
  const memberIds = new Set(members.map((member) => member.id));
  const memberIdByHandle = new Map(
    members.map((member) => [member.screen_name.toLowerCase(), member.id]),
  );
  const endpoint = mode === "add" ? "ListAddMember" : "ListRemoveMember";
  const rows: MembershipRow[] = [];
  let changed = false;

  for (const token of tokens) {
    const user = token.replace(/^@/, "");
    const row = (status: MembershipStatus, id = "", error = "") =>
      rows.push({ user, id, status, error });
    let id = /^\d+$/.test(token)
      ? token
      : memberIdByHandle.get(user.toLowerCase());
    if (id === undefined) {
      try {
        id = (await withRateLimitWait(() => lookupUserId(user))) ?? undefined;
      } catch (error) {
        row(
          "failed",
          "",
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      if (id === undefined) {
        row("not-found");
        continue;
      }
    }
    if (memberIds.has(id) === (mode === "add")) {
      row("already", id);
      continue;
    }

    if (changed) await sleep(delayMs);
    changed = true;
    const userId = id;
    try {
      const data = await withRateLimitWait(() =>
        twitterPostFetch(endpoint, QUERY_IDS[endpoint], { listId, userId }),
      );
      // X attaches a harmless DecodeException error to successful answers; member_count marks success.
      if (typeof obj(obj(obj(data).data).list).member_count === "number") {
        if (mode === "add") memberIds.add(userId);
        else memberIds.delete(userId);
        row(mode === "add" ? "added" : "removed", userId);
      } else {
        row("failed", userId, graphqlErrorMessage(data));
      }
    } catch (error) {
      row(
        "failed",
        userId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return rows;
}

const MEMBERSHIP_ARGS = [
  LIST_ARG,
  {
    name: "users",
    type: "str[]" as const,
    description: "Comma-separated handles (name or @name) or numeric user ids",
  },
  {
    name: "users-file",
    type: "str" as const,
    description: "File with one handle or numeric user id per line",
    "x-unicli-kind": "path" as const,
  },
  {
    name: "delay",
    type: "float" as const,
    default: 1.5,
    description: "Seconds between membership changes",
  },
];

const MEMBERSHIP_COLUMNS = ["user", "id", "status", "error"];

cli({
  site: "twitter",
  name: "list-create",
  description: "Create a Twitter/X list",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  operation_family: "create",
  args: [
    {
      name: "name",
      type: "str",
      required: true,
      positional: true,
      description: "List name",
    },
    {
      name: "private",
      type: "bool",
      default: false,
      description: "Create a private list",
    },
    {
      name: "description",
      type: "str",
      default: "",
      description: "List description",
    },
  ],
  columns: ["id", "name", "mode", "url"],
  socialCapabilities: ["lists"],
  func: async (_page, kwargs) => {
    const data = await twitterPostFetch("CreateList", QUERY_IDS.CreateList, {
      isPrivate: boolArg(kwargs.private),
      name: str(kwargs.name),
      description: str(kwargs.description),
    });
    const list = obj(obj(obj(data).data).list);
    const id = typeof list.id_str === "string" ? list.id_str : "";
    if (!id) {
      throw Object.assign(
        new Error(`Twitter/X CreateList failed: ${graphqlErrorMessage(data)}`),
        { code: "api_error", retryable: false },
      );
    }
    return [
      {
        id,
        name: String(list.name ?? ""),
        mode: String(list.mode ?? ""),
        url: `https://x.com/i/lists/${id}`,
      },
    ];
  },
});

cli({
  site: "twitter",
  name: "list-members",
  description: "List members of a Twitter/X list",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    LIST_ARG,
    { name: "limit", type: "int", default: 20, description: "Number of users" },
  ],
  columns: USER_COLUMNS,
  socialCapabilities: ["read", "lists"],
  func: async (_page, kwargs) =>
    collectTimelineUsers(
      listMemberPages(listIdArg(kwargs.list)),
      intArg(kwargs.limit, 20, Number.POSITIVE_INFINITY),
    ),
});

cli({
  site: "twitter",
  name: "list-add",
  description:
    "Add users to a Twitter/X list, skipping users who are already members",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  operation_family: "update",
  args: MEMBERSHIP_ARGS,
  columns: MEMBERSHIP_COLUMNS,
  socialCapabilities: ["lists"],
  func: async (_page, kwargs) => changeMembership(kwargs, "add"),
});

cli({
  site: "twitter",
  name: "list-remove",
  description:
    "Remove users from a Twitter/X list, skipping users who are not members",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  operation_family: "update",
  args: MEMBERSHIP_ARGS,
  columns: MEMBERSHIP_COLUMNS,
  socialCapabilities: ["lists"],
  func: async (_page, kwargs) => changeMembership(kwargs, "remove"),
});

cli({
  site: "twitter",
  name: "list-tweets",
  description: "Read tweets from a Twitter/X list timeline",
  domain: "x.com",
  strategy: Strategy.COOKIE,
  args: [
    LIST_ARG,
    { name: "limit", type: "int", default: 20, description: "Number of posts" },
    {
      name: "since",
      type: "str",
      description:
        "Stop at the first post older than this ISO 8601 date or datetime",
    },
  ],
  columns: TWEET_COLUMNS,
  socialCapabilities: ["read", "lists", "user_content"],
  func: async (_page, kwargs) =>
    collectTimelineTweets(
      timelinePages(
        "ListLatestTweetsTimeline",
        QUERY_IDS.ListLatestTweetsTimeline,
        { listId: listIdArg(kwargs.list), count: 100 },
        ["data", "list", "tweets_timeline", "timeline", "instructions"],
      ),
      {
        limit: intArg(kwargs.limit, 20, Number.POSITIVE_INFINITY),
        since: sinceArg(kwargs.since),
        stopAtSince: true,
      },
    ),
});
