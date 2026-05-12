import { describe, expect, it } from "vitest";
import {
  mapTvmazeSearchRows,
  mapTvmazeShowRow,
  requireTvmazeLimit,
  requireTvmazeShowId,
  stripTvmazeHtml,
} from "./shows.js";

describe("tvmaze agent-facing show commands", () => {
  it("validates shared arguments", () => {
    expect(requireTvmazeLimit(undefined)).toBe(20);
    expect(requireTvmazeLimit("50")).toBe(50);
    expect(() => requireTvmazeLimit("51")).toThrow("tvmaze limit must");
    expect(requireTvmazeShowId("82")).toBe(82);
    expect(() => requireTvmazeShowId("0")).toThrow("positive integer");
  });

  it("strips TVmaze HTML summaries", () => {
    expect(stripTvmazeHtml("<p><b>Hello</b> &amp; goodbye&#33;</p>")).toBe(
      "Hello & goodbye!",
    );
  });

  it("maps TVmaze search rows", () => {
    expect(
      mapTvmazeSearchRows(
        [
          {
            score: 0.91,
            show: {
              id: 82,
              name: "Game of Thrones",
              type: "Scripted",
              language: "English",
              genres: ["Drama", "Fantasy"],
              status: "Ended",
              premiered: "2011-04-17",
              network: { name: "HBO" },
              rating: { average: 8.9 },
              summary: "<p>Seven kingdoms.</p>",
              url: "https://www.tvmaze.com/shows/82/game-of-thrones",
            },
          },
        ],
        20,
      ),
    ).toMatchObject([
      {
        rank: 1,
        id: 82,
        name: "Game of Thrones",
        network: "HBO",
        rating: 8.9,
        matchScore: 0.91,
        summary: "Seven kingdoms.",
      },
    ]);
  });

  it("maps TVmaze show rows", () => {
    expect(
      mapTvmazeShowRow({
        id: 82,
        name: "Game of Thrones",
        type: "Scripted",
        language: "English",
        genres: ["Drama", "Fantasy"],
        status: "Ended",
        premiered: "2011-04-17",
        ended: "2019-05-19",
        runtime: "60",
        averageRuntime: 63,
        network: { name: "HBO", country: { name: "United States" } },
        schedule: { days: ["Sunday"], time: "21:00" },
        rating: { average: "8.9" },
        externals: { imdb: "tt0944947", thetvdb: "121361" },
        officialSite: "https://www.hbo.com/game-of-thrones",
        summary: "<p>Seven kingdoms.</p>",
        url: "https://www.tvmaze.com/shows/82/game-of-thrones",
      }),
    ).toMatchObject({
      id: 82,
      name: "Game of Thrones",
      genres: "Drama, Fantasy",
      runtime: 60,
      country: "United States",
      schedule: "Sunday 21:00",
      imdb: "tt0944947",
      thetvdb: 121361,
    });
  });
});
