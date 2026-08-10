import { describe, expect, it } from "vitest";
import {
  absoluteOpenReviewPdf,
  authorFromSignatures,
  classifyReviewNote,
  coerceOpenReviewInt,
  formatOpenReviewDate,
  mapOpenReviewNoteRow,
  mapReviewThreadRows,
  openReviewChallengeUrl,
  openReviewClearanceCookieHeader,
  openReviewPdfFilename,
  readContent,
  requireForumId,
  requireOpenReviewMaxChars,
  requireOpenReviewLimit,
  requireOpenReviewOffset,
  requireOpenReviewPageRange,
  requireOpenReviewSearchMatches,
  requireProfileId,
} from "./papers.js";

describe("openreview agent-facing paper commands", () => {
  it("parses challenge envelopes and sends access/clearance without refresh", () => {
    const challenge =
      "https://openreview.net/challenge?redirect=https%3A%2F%2Fapi2.openreview.net%2Fnotes";
    expect(
      openReviewChallengeUrl(
        JSON.stringify({
          name: "ChallengeRequiredError",
          status: 403,
          details: { challengeUrl: challenge },
        }),
      ),
    ).toBe(challenge);
    expect(openReviewChallengeUrl("<html>forbidden</html>")).toBeUndefined();
    expect(
      openReviewClearanceCookieHeader({
        "openreview.clearanceToken": "clear",
        "openreview.accessToken": "private-access",
        "openreview.refreshToken": "stale-refresh",
      }),
    ).toBe(
      "openreview.accessToken=private-access; openreview.clearanceToken=clear",
    );
    expect(openReviewClearanceCookieHeader(null)).toBeUndefined();
  });

  it("validates integer, forum id, and profile id arguments", () => {
    expect(coerceOpenReviewInt("42")).toBe(42);
    expect(Number.isNaN(coerceOpenReviewInt("1.5"))).toBe(true);
    expect(requireOpenReviewLimit(undefined, 25, 50)).toBe(25);
    expect(requireOpenReviewLimit("50", 25, 50)).toBe(50);
    expect(() => requireOpenReviewLimit("51", 25, 50)).toThrow(
      "openreview limit",
    );
    expect(requireOpenReviewOffset(undefined)).toBe(0);
    expect(() => requireOpenReviewOffset("-1")).toThrow("non-negative");
    expect(requireForumId("5sRnsubyAK")).toBe("5sRnsubyAK");
    expect(requireForumId("https://openreview.net/forum?id=5sRnsubyAK")).toBe(
      "5sRnsubyAK",
    );
    expect(() => requireForumId("https://openreview.net/forum?id=x")).toThrow(
      "not a valid",
    );
    expect(requireProfileId("~Yoshua_Bengio1")).toBe("~Yoshua_Bengio1");
    expect(() => requireProfileId("Yoshua_Bengio1")).toThrow("not valid");
    expect(requireOpenReviewPageRange("2", "4")).toEqual({
      firstPage: 2,
      lastPage: 4,
    });
    expect(() => requireOpenReviewPageRange("4", "2")).toThrow("last-page");
    expect(requireOpenReviewMaxChars(undefined)).toBe(40000);
    expect(requireOpenReviewMaxChars("1000")).toBe(1000);
    expect(() => requireOpenReviewMaxChars("999")).toThrow("max-chars");
    expect(openReviewPdfFilename("abcDEF123", "A / Paper: Demo")).toBe(
      "abcDEF123-A-Paper-Demo.pdf",
    );
    try {
      requireOpenReviewLimit(0, 25, 50);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
    expect(() => requireOpenReviewSearchMatches([], "no such paper")).toThrow(
      "No OpenReview papers",
    );
    try {
      requireOpenReviewSearchMatches([], "no such paper");
    } catch (error) {
      expect(error).toMatchObject({ code: "empty_result" });
    }
  });

  it("maps OpenReview content.value note fields", () => {
    const note = {
      id: "5sRnsubyAK",
      pdate: 1760000000000,
      content: {
        title: { value: " A   Paper " },
        authors: { value: ["Jane Doe", "Max Co"] },
        keywords: { value: ["rl", "agents"] },
        venue: { value: "ICLR 2026" },
        venueid: { value: "ICLR.cc/2026/Conference" },
        primary_area: { value: "AI" },
        abstract: { value: " Long   abstract " },
        pdf: { value: "/pdf/abc.pdf" },
      },
    };
    expect(readContent(note.content, "title")).toBe(" A   Paper ");
    expect(formatOpenReviewDate(note.pdate)).toBe("2025-10-09");
    expect(absoluteOpenReviewPdf("/pdf/abc.pdf")).toBe(
      "https://openreview.net/pdf/abc.pdf",
    );
    expect(mapOpenReviewNoteRow(note)).toEqual({
      id: "5sRnsubyAK",
      title: "A Paper",
      authors: "Jane Doe, Max Co",
      keywords: "rl, agents",
      venue: "ICLR 2026",
      venueid: "ICLR.cc/2026/Conference",
      primary_area: "AI",
      abstract: "Long abstract",
      pdate: "2025-10-09",
      pdf: "https://openreview.net/pdf/abc.pdf",
      pdf_url: "https://openreview.net/pdf/abc.pdf",
      url: "https://openreview.net/forum?id=5sRnsubyAK",
      source_url: "https://openreview.net/forum?id=5sRnsubyAK",
      landing_url: "https://openreview.net/forum?id=5sRnsubyAK",
      source_adapter: "openreview",
      openreview_id: "5sRnsubyAK",
      date: "2025-10-09",
      retrieved_at: expect.any(String),
    });
  });

  it("falls back from author ids and classifies review notes", () => {
    expect(
      mapOpenReviewNoteRow({
        id: "abcDEF123",
        content: {
          title: { value: "Fallback" },
          authorids: { value: ["~Jane_Doe1"] },
        },
      }),
    ).toMatchObject({ authors: "Jane Doe" });
    expect(
      classifyReviewNote({ invitations: ["A/-/Official_Review"] }, false),
    ).toBe("REVIEW");
    expect(classifyReviewNote({ invitations: ["A/-/Decision"] }, false)).toBe(
      "DECISION",
    );
    expect(
      classifyReviewNote(
        {
          invitations: ["A/-/Official_Comment"],
          signatures: ["A/Authors"],
        },
        false,
      ),
    ).toBe("AUTHOR_RESPONSE");
    expect(
      authorFromSignatures(["ICLR.cc/2026/Conference/Reviewer_abcd"]),
    ).toBe("Reviewer_abcd");
    expect(authorFromSignatures(["~Jane_Doe1"])).toBe("Jane Doe");
  });

  it("maps review thread rows in chronological order with truncation", () => {
    const rows = mapReviewThreadRows(
      {
        id: "forum123",
        signatures: ["~Paper_Author1"],
        content: {
          title: { value: "Root title" },
          abstract: { value: "Root abstract" },
        },
      },
      [
        {
          id: "late",
          cdate: 2,
          invitations: ["Venue/-/Decision"],
          signatures: ["Venue/Program_Chairs"],
          content: { decision: { value: "Accept" } },
        },
        {
          id: "early",
          cdate: 1,
          invitations: ["Venue/-/Official_Review"],
          signatures: ["Venue/Reviewer_abc"],
          content: {
            summary: { value: "x".repeat(220) },
            rating: { value: "8: accept" },
            confidence: { value: "4: high" },
          },
        },
      ],
      "forum123",
      200,
    );
    expect(rows.map((row) => row.type)).toEqual([
      "PAPER",
      "REVIEW",
      "DECISION",
    ]);
    expect(rows[1]).toMatchObject({
      forum: "forum123",
      note_id: "early",
      author: "Reviewer_abc",
      invitation: "Venue/-/Official_Review",
      created_at: "1970-01-01",
      source_url: "https://openreview.net/forum?id=forum123&noteId=early",
      rating: "8: accept",
      confidence: "4: high",
      text_chars: expect.any(Number),
      text_truncated: true,
    });
    expect(String(rows[1].text)).toHaveLength(200);
    expect(String(rows[1].text).endsWith("...")).toBe(true);
  });
});
