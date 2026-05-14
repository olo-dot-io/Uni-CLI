import { describe, expect, it } from "vitest";

import { mapMastodonStatusRows, normalizeMastodonAccount } from "./statuses.js";

describe("mastodon statuses adapter helpers", () => {
  it("normalizes account handles and instance overrides", () => {
    expect(normalizeMastodonAccount("gargron@mastodon.social")).toEqual({
      acct: "gargron",
      instance: "mastodon.social",
    });

    expect(normalizeMastodonAccount("@gargron", "mastodon.social")).toEqual({
      acct: "gargron",
      instance: "mastodon.social",
    });
  });

  it("maps API statuses into stable social rows", () => {
    expect(
      mapMastodonStatusRows(
        [
          {
            created_at: "2026-05-14T10:00:00.000Z",
            content: "<p>Hello <strong>fediverse</strong></p>",
            url: "https://mastodon.social/@gargron/1",
            reblogs_count: 2,
            favourites_count: 3,
            replies_count: 4,
            account: { acct: "gargron", display_name: "Gargron" },
          },
        ],
        10,
      ),
    ).toEqual([
      {
        rank: 1,
        author: "Gargron",
        handle: "@gargron",
        content: "Hello fediverse",
        reblogs: 2,
        favorites: 3,
        replies: 4,
        url: "https://mastodon.social/@gargron/1",
        date: "2026-05-14T10:00:00.000Z",
      },
    ]);
  });

  it("drops empty activity rows and decodes common HTML entities", () => {
    expect(
      mapMastodonStatusRows(
        [
          {
            created_at: "2026-05-14T10:00:00.000Z",
            content: "",
            url: "https://mastodon.social/users/Gargron/statuses/1/activity",
            account: { acct: "Gargron", display_name: "Eugen Rochko" },
          },
          {
            created_at: "2026-05-14T11:00:00.000Z",
            content: "<p>Don&#39;t escape &amp; ship</p>",
            url: "https://mastodon.social/@Gargron/2",
            account: { acct: "Gargron", display_name: "Eugen Rochko" },
          },
        ],
        10,
      ),
    ).toEqual([
      {
        rank: 1,
        author: "Eugen Rochko",
        handle: "@Gargron",
        content: "Don't escape & ship",
        reblogs: 0,
        favorites: 0,
        replies: 0,
        url: "https://mastodon.social/@Gargron/2",
        date: "2026-05-14T11:00:00.000Z",
      },
    ]);
  });
});
