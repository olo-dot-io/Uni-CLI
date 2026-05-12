import { describe, expect, it } from "vitest";
import {
  buildStackReadRows,
  decodeStackHtmlEntities,
  mapStackQuestionRows,
  mapStackUserRows,
  requireStackLimit,
  requireStackMinInt,
  requireStackQuestionId,
  requireStackString,
  sortStackAnswers,
  stackHtmlToText,
} from "./questions.js";

describe("stackoverflow agent-facing commands", () => {
  it("validates ids, strings, limits, and converts Stack Exchange HTML", () => {
    expect(requireStackQuestionId(" 79935770 ")).toBe("79935770");
    expect(() => requireStackQuestionId("abc")).toThrow("numeric question id");
    expect(requireStackString(" rust ", "tag")).toBe("rust");
    expect(() => requireStackString("", "tag")).toThrow("cannot be empty");
    expect(requireStackLimit(undefined, 20, 100, "limit")).toBe(20);
    expect(() => requireStackLimit("101", 20, 100, "limit")).toThrow(
      "[1, 100]",
    );
    expect(requireStackMinInt(undefined, 4000, 100, "max-length")).toBe(4000);
    expect(() => requireStackMinInt("99", 4000, 100, "max-length")).toThrow(
      ">= 100",
    );
    expect(decodeStackHtmlEntities("Rust&#39;s &lt;Trait&gt; &amp; API")).toBe(
      "Rust's <Trait> & API",
    );
    expect(
      stackHtmlToText(
        '<p>Hello &amp; <code>world</code></p><ul><li><a href="https://x.test">link</a></li></ul>',
      ),
    ).toBe("Hello & `world`\n- link (https://x.test)");
  });

  it("maps question and user list rows with surface column names", () => {
    expect(
      mapStackQuestionRows([
        {
          question_id: 1,
          title: "Use &lt;T&gt;",
          score: 5,
          answer_count: 2,
          view_count: 99,
          is_answered: true,
          tags: ["typescript", "generics"],
          owner: { display_name: "Jon&#39;s Bot" },
          creation_date: 1_700_000_000,
          last_activity_date: 1_700_100_000,
        },
      ]),
    ).toEqual([
      {
        rank: 1,
        id: 1,
        title: "Use <T>",
        score: 5,
        answers: 2,
        views: 99,
        isAnswered: true,
        tags: "typescript, generics",
        author: "Jon's Bot",
        createdAt: "2023-11-14",
        lastActivityAt: "2023-11-16",
        url: "https://stackoverflow.com/questions/1",
      },
    ]);

    expect(
      mapStackUserRows([
        {
          user_id: 22656,
          display_name: "Jon Skeet",
          reputation: 1_500_000,
          badge_counts: { gold: 900, silver: 9000, bronze: 90000 },
          location: "Reading &amp; London",
          creation_date: 1_200_000_000,
          last_access_date: 1_700_000_000,
        },
      ]),
    ).toEqual([
      {
        userId: 22656,
        displayName: "Jon Skeet",
        reputation: 1_500_000,
        goldBadges: 900,
        silverBadges: 9000,
        bronzeBadges: 90000,
        location: "Reading & London",
        createdAt: "2008-01-10",
        lastAccessAt: "2023-11-14",
        url: "https://stackoverflow.com/users/22656",
      },
    ]);
  });

  it("sorts accepted answers first and builds bounded read rows", async () => {
    expect(
      sortStackAnswers({ accepted_answer_id: 3 }, [
        { answer_id: 2, score: 50 },
        { answer_id: 3, score: 1 },
        { answer_id: 4, score: 40 },
      ]).map((answer) => answer.answer_id),
    ).toEqual([3, 2, 4]);

    const rows = await buildStackReadRows(
      {
        title: "Why?",
        body: "<p>Question body</p>",
        score: 10,
        accepted_answer_id: 3,
        owner: { display_name: "asker" },
        link: "https://stackoverflow.com/q/1",
      },
      [{ body: "<p>Needs code</p>", score: 1, owner: { display_name: "c1" } }],
      [
        {
          answer_id: 2,
          body: "<p>High score</p>",
          score: 20,
          owner: { display_name: "a2" },
        },
        {
          answer_id: 3,
          is_accepted: true,
          body: "<p>Accepted</p>",
          score: 2,
          owner: { display_name: "a3" },
        },
      ],
      async () => ({
        items: [
          {
            post_id: 3,
            body: "<p>Good point</p>",
            score: 0,
            owner: { display_name: "c3" },
          },
        ],
      }),
      {
        answersLimit: 2,
        commentsLimit: 2,
        maxLength: 100,
        label: "stackoverflow/1",
      },
    );

    expect(rows).toEqual([
      {
        type: "POST",
        author: "asker",
        score: 10,
        accepted: "",
        text: "Why?\n\nQuestion body\n\nhttps://stackoverflow.com/q/1",
      },
      {
        type: "Q-COMMENT",
        author: "c1",
        score: 1,
        accepted: "",
        text: "  > Needs code",
      },
      {
        type: "ANSWER",
        author: "a3",
        score: 2,
        accepted: "true",
        text: "Accepted",
      },
      {
        type: "A-COMMENT",
        author: "c3",
        score: 0,
        accepted: "",
        text: "  > Good point",
      },
      {
        type: "ANSWER",
        author: "a2",
        score: 20,
        accepted: "",
        text: "High score",
      },
    ]);
  });

  it("refuses partial answer-comment pages", async () => {
    await expect(
      buildStackReadRows(
        { title: "Q", accepted_answer_id: 2 },
        [],
        [{ answer_id: 2 }],
        async () => ({ items: [], has_more: true }),
        {
          answersLimit: 1,
          commentsLimit: 2,
          maxLength: 100,
          label: "stackoverflow/2",
        },
      ),
    ).rejects.toThrow("exceed one API page");
  });
});
