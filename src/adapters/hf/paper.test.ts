import { describe, expect, it } from "vitest";
import { getAdapter } from "../../registry.js";
import { hfEndpoint, mapHfPaperRow, requireHfPaperId } from "./paper.js";

describe("hf agent-facing paper command", () => {
  it("validates modern arXiv ids", () => {
    expect(requireHfPaperId(" 1706.03762v3 ")).toBe("1706.03762v3");
    expect(requireHfPaperId("2501.12345")).toBe("2501.12345");
    expect(() => requireHfPaperId("cs/9901001")).toThrow("valid arXiv");
    expect(() => requireHfPaperId("")).toThrow("cannot be empty");
  });

  it("normalizes endpoint values", () => {
    expect(hfEndpoint("https://hf.example///")).toBe("https://hf.example");
    expect(hfEndpoint("")).toBe("https://huggingface.co");
  });

  it("maps HF paper data to stable columns", () => {
    expect(
      mapHfPaperRow(
        {
          id: "1706.03762",
          title: "Attention Is All You Need",
          authors: [{ name: "Ashish Vaswani" }, { fullname: "Noam Shazeer" }],
          publishedAt: "2017-06-12T00:00:00.000Z",
          upvotes: 1234,
          ai_keywords: ["transformer", "attention"],
          summary: "Paper summary",
          ai_summary: "AI summary",
        },
        "https://hf.example/",
      ),
    ).toEqual({
      id: "1706.03762",
      title: "Attention Is All You Need",
      authors: "Ashish Vaswani, Noam Shazeer",
      publishedAt: "2017-06-12",
      upvotes: 1234,
      aiKeywords: "transformer, attention",
      summary: "Paper summary",
      aiSummary: "AI summary",
      url: "https://hf.example/papers/1706.03762",
    });
  });

  it("rejects empty HF paper payloads", () => {
    expect(() => mapHfPaperRow({})).toThrow("no paper data");
  });

  it("advertises scholarly capabilities for meta-command discovery", () => {
    expect(getAdapter("hf")?.commands.paper?.capabilities).toEqual([
      "http.fetch",
      "scholar.get",
      "scholar.pdf",
      "scholar.code",
    ]);
  });
});
