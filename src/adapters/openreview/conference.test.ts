import { describe, expect, it } from "vitest";

import {
  classifyOpenReviewNote,
  extractOpenReviewArtifacts,
  normalizeOpenReviewThread,
  requireOpenReviewVenueId,
  sanitizePublicOpenReviewEntity,
} from "./conference.js";

describe("OpenReview conference archive normalization", () => {
  it("accepts venue ids and group URLs but rejects invitation ids", () => {
    expect(requireOpenReviewVenueId("ICML.cc/2026/Conference")).toBe(
      "ICML.cc/2026/Conference",
    );
    expect(
      requireOpenReviewVenueId(
        "https://openreview.net/group?id=ICLR.cc%2F2025%2FConference#tab-accept",
      ),
    ).toBe("ICLR.cc/2025/Conference");
    expect(() =>
      requireOpenReviewVenueId("ICML.cc/2026/Conference/-/Submission"),
    ).toThrow("not a valid");
  });

  it("classifies review lifecycle notes without venue-specific labels", () => {
    expect(
      classifyOpenReviewNote({ invitations: ["V/S1/-/Official_Review"] }),
    ).toBe("review");
    expect(
      classifyOpenReviewNote({ invitations: ["V/S1/-/Author_Response"] }),
    ).toBe("author_response");
    expect(
      classifyOpenReviewNote({ invitations: ["V/S1/-/Meta_Review"] }),
    ).toBe("meta_review");
    expect(classifyOpenReviewNote({ invitations: ["V/S1/-/Decision"] })).toBe(
      "decision",
    );
  });

  it("retains raw thread structure, nested reply links, and concern fields", () => {
    const thread = normalizeOpenReviewThread({
      id: "paper123",
      forum: "paper123",
      number: 42,
      content: {
        title: { value: "Paper" },
        venue: { value: "ICML 2026 Spotlight" },
      },
      details: {
        replies: [
          {
            id: "review1",
            forum: "paper123",
            replyto: "paper123",
            tcdate: 10,
            invitations: ["V/S42/-/Official_Review"],
            content: {
              weaknesses: { value: "Missing ablation" },
              rating: { value: "6" },
            },
          },
          {
            id: "reply1",
            forum: "paper123",
            replyto: "review1",
            tcdate: 20,
            invitations: ["V/S42/-/Author_Response"],
            content: { response: { value: "Added ablation" } },
          },
        ],
      },
    });
    expect(thread).toMatchObject({
      forum_id: "paper123",
      title: "Paper",
      paper_number: 42,
    });
    expect(thread.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          note_id: "review1",
          parent_note_id: "paper123",
          type: "review",
          concerns: { weaknesses: "Missing ablation" },
        }),
        expect.objectContaining({
          note_id: "reply1",
          parent_note_id: "review1",
          type: "author_response",
        }),
      ]),
    );
  });

  it("separates OpenReview files from external code and data links", () => {
    const refs = extractOpenReviewArtifacts({
      id: "paper123",
      forum: "paper123",
      tmdate: 123,
      content: {
        pdf: { value: "/pdf?id=paper123" },
        supplementary_material: {
          value: "/attachment?id=paper123&name=supplementary_material",
        },
        code: { value: "https://github.com/example/project" },
        project_page: { value: "https://example.org/paper" },
      },
    });
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "pdf", kind: "openreview_file" }),
        expect.objectContaining({
          field: "supplementary_material",
          kind: "openreview_file",
        }),
        expect.objectContaining({ field: "code", kind: "external_link" }),
        expect.objectContaining({
          field: "project_page",
          kind: "external_link",
        }),
      ]),
    );
  });

  it("uses login state for transport without exporting restricted notes or fields", () => {
    expect(
      sanitizePublicOpenReviewEntity({
        id: "public",
        readers: ["everyone"],
        content: {
          title: { value: "Visible" },
          confidential: { value: "Hidden", readers: ["Venue/PCs"] },
        },
        details: {
          replies: [
            { id: "visible-reply", readers: ["everyone"], content: {} },
            { id: "private-reply", readers: ["Venue/Reviewers"], content: {} },
          ],
        },
      }),
    ).toMatchObject({
      content: { title: { value: "Visible" } },
      details: { replies: [{ id: "visible-reply" }] },
    });
    expect(
      sanitizePublicOpenReviewEntity({
        id: "private",
        readers: ["Venue/Reviewers"],
      }),
    ).toBeUndefined();
  });
});
