import { describe, expect, it } from "vitest";

import {
  analyzeRetrievalQuery,
  isSpecificSingleTermQuery,
  scoreRetrievalAlternatives,
  scoreRetrievalCandidate,
  splitRetrievalDisjunction,
} from "../../../src/engine/retrieval-relevance.js";

describe("retrieval relevance", () => {
  it("drops transport qualifiers while preserving technical and Unicode terms", () => {
    expect(
      analyzeRetrievalQuery(
        "site:docs.nvidia.com how C++ NVL72 世界模型 bandwidth",
      ).terms,
    ).toEqual(["c++", "nvl72", "世界模型", "bandwidth"]);
  });

  it("matches short technical tokens on token boundaries", () => {
    const analysis = analyzeRetrievalQuery("AI");

    expect(
      scoreRetrievalCandidate(analysis, {
        title: "Training infrastructure",
      }).matchedTerms,
    ).toBe(0);
    expect(
      scoreRetrievalCandidate(analysis, {
        title: "AI infrastructure",
      }).matchedTerms,
    ).toBe(1);
    expect(
      scoreRetrievalCandidate(analysis, {
        url: "https://example.com/training-infrastructure",
      }).matchedTerms,
    ).toBe(0);
  });

  it("does not reward English substrings while retaining CJK compounds", () => {
    expect(
      scoreRetrievalCandidate(analyzeRetrievalQuery("link"), {
        title: "NVLink topology",
      }).matchedTerms,
    ).toBe(0);
    expect(
      scoreRetrievalCandidate(analyzeRetrievalQuery("世界模型"), {
        title: "基础世界模型研究",
      }).matchedTerms,
    ).toBe(1);
  });

  it("treats OR outside quoted phrases as alternatives", () => {
    expect(splitRetrievalDisjunction('NVLink OR "Infinity OR Fabric"')).toEqual(
      ["NVLink", '"Infinity OR Fabric"'],
    );
    const analyses = splitRetrievalDisjunction(
      'NVLink OR "Infinity Fabric"',
    ).map(analyzeRetrievalQuery);

    expect(
      scoreRetrievalAlternatives(
        analyses,
        { title: "NVLink topology" },
        { requireAllTerms: true },
      ).qualifies,
    ).toBe(true);
    expect(
      scoreRetrievalAlternatives(
        analyses,
        { title: "Ethernet topology" },
        { requireAllTerms: true },
      ).qualifies,
    ).toBe(false);
  });

  it("requires literal overlap for identifiers but not broad lowercase concepts", () => {
    expect(isSpecificSingleTermQuery("NVLink")).toBe(true);
    expect(isSpecificSingleTermQuery("NVL72")).toBe(true);
    expect(isSpecificSingleTermQuery("昇腾")).toBe(true);
    expect(isSpecificSingleTermQuery("accelerator")).toBe(false);
  });
});
