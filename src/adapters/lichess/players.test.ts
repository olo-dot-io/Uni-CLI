import { describe, expect, it } from "vitest";
import {
  formatLichessTimestamp,
  mapLichessTopRows,
  mapLichessUserRow,
  requireLichessLimit,
  requireLichessPerf,
  requireLichessUsername,
} from "./players.js";

describe("lichess agent-facing player commands", () => {
  it("validates usernames, perf names, and limits", () => {
    expect(requireLichessUsername(" DrNykterstein ")).toBe("DrNykterstein");
    expect(() => requireLichessUsername("x")).toThrow("2-30");
    expect(requireLichessPerf("blitz")).toBe("blitz");
    expect(() => requireLichessPerf("bughouse")).toThrow("must be one of");
    expect(requireLichessLimit(undefined, 10)).toBe(10);
    expect(requireLichessLimit("200", 10)).toBe(200);
    expect(() => requireLichessLimit("201", 10)).toThrow(
      "limit must be an integer",
    );
  });

  it("maps leaderboard rows for a selected perf", () => {
    expect(
      mapLichessTopRows(
        {
          users: [
            {
              username: "DrNykterstein",
              id: "drnykterstein",
              title: "GM",
              patron: true,
              perfs: { blitz: { rating: 3100, progress: 12 } },
            },
          ],
        },
        "blitz",
        10,
      ),
    ).toEqual([
      {
        rank: 1,
        username: "DrNykterstein",
        id: "drnykterstein",
        title: "GM",
        rating: 3100,
        progress: 12,
        patron: true,
        url: "https://lichess.org/@/DrNykterstein/perf/blitz",
      },
    ]);
    expect(() => mapLichessTopRows({ users: [] }, "rapid", 10)).toThrow(
      "no leaderboard rows",
    );
  });

  it("maps user profiles and picks the most-played perf", () => {
    expect(formatLichessTimestamp(1760000000000)).toBe(
      "2025-10-09T08:53:20.000Z",
    );
    expect(
      mapLichessUserRow(
        {
          username: "DrNykterstein",
          id: "drnykterstein",
          title: "GM",
          patron: true,
          online: true,
          createdAt: 1760000000000,
          seenAt: 1760000100000,
          count: { all: 10, win: 6, loss: 3, draw: 1 },
          perfs: {
            bullet: { rating: 3200, games: 50 },
            blitz: { rating: 3100, games: 100 },
            puzzle: { rating: 2800, games: 999 },
          },
          profile: {
            fideRating: 2882,
            country: "NO",
            bio: "World champion",
          },
        },
        "drnykterstein",
      ),
    ).toMatchObject({
      username: "DrNykterstein",
      topPerfName: "blitz",
      topPerfRating: 3100,
      topPerfGames: 100,
      gamesAll: 10,
      country: "NO",
      url: "https://lichess.org/@/DrNykterstein",
    });
    expect(() => mapLichessUserRow({ disabled: true }, "closed")).toThrow(
      "closed or disabled",
    );
  });
});
