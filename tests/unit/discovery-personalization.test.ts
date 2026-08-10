import { describe, expect, it } from "vitest";
import {
  classifyPersonalization,
  personalizationIntentFamilies,
} from "../../src/discovery/personalization.js";
import { searchDocuments } from "../../src/discovery/search.js";

describe("personalized discovery", () => {
  it("classifies current-user workflows without labeling public profiles", () => {
    expect(
      classifyPersonalization({
        command: "saved",
        description: "Read saved notes for the logged-in account",
        category: "social",
        auth: "required",
      }),
    ).toBe("library");
    expect(
      classifyPersonalization({
        command: "profile",
        description: "Read any public user profile",
        category: "social",
        auth: "none",
      }),
    ).toBeUndefined();
    expect(
      classifyPersonalization({
        command: "notifications",
        description: "Recent notifications",
        category: "social",
        auth: "required",
      }),
    ).toBe("activity");
  });

  it("recognizes bilingual personalization intent families", () => {
    expect(
      personalizationIntentFamilies(
        new Set(["recommendations", "saved", "通知"]),
      ),
    ).toEqual(["feed", "library", "activity"]);
  });

  it("boosts the matching personal family and supports hard filtering", () => {
    const documents = [
      {
        site: "social",
        command: "collection-create",
        description: "Create a collection",
        category: "social",
        auth: "required" as const,
      },
      {
        site: "social",
        command: "saved",
        description: "Read saved posts for the logged-in account",
        category: "social",
        auth: "required" as const,
        personalization: "library" as const,
      },
    ];
    const results = searchDocuments(documents, "saved posts", 2, {
      personalized: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      command: "saved",
      personalization: "library",
      ranking: {
        signals: expect.arrayContaining(["personalization:library"]),
      },
    });
  });
});
