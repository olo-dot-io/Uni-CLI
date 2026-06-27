import { describe, expect, it } from "vitest";
import { resolveCommand } from "../../registry.js";
import {
  arxivArtifactFilename,
  decodeArxivEntities,
  normalizeArxivId,
  parseArxivEntries,
  requireArxivAuthor,
  requireArxivCategory,
  requireArxivMaxChars,
  requireArxivPageRange,
  requireArxivLimit,
} from "./papers.js";

describe("arxiv agent-facing author and recent commands", () => {
  it("validates author, category, and limit inputs", () => {
    expect(requireArxivAuthor(" Yoshua Bengio ")).toBe("Yoshua Bengio");
    expect(() => requireArxivAuthor("")).toThrow("cannot be empty");
    expect(requireArxivCategory("cs.CL")).toBe("cs.CL");
    expect(requireArxivCategory("q-bio.NC")).toBe("q-bio.NC");
    expect(() => requireArxivCategory("../cs.CL")).toThrow("Invalid arXiv");
    expect(requireArxivLimit(undefined, 20)).toBe(20);
    expect(requireArxivLimit("50", 20)).toBe(50);
    expect(() => requireArxivLimit("51", 20)).toThrow("arxiv limit");
  });

  it("validates read IDs, page ranges, max text bounds, and filenames", () => {
    expect(normalizeArxivId("arxiv:1706.03762v7")).toBe("1706.03762v7");
    expect(normalizeArxivId("https://arxiv.org/abs/1706.03762")).toBe(
      "1706.03762",
    );
    expect(normalizeArxivId("https://arxiv.org/pdf/hep-th/9901001.pdf")).toBe(
      "hep-th/9901001",
    );
    expect(() => normalizeArxivId("../1706.03762")).toThrow("Invalid arXiv");
    expect(requireArxivPageRange("2", "4")).toEqual({
      firstPage: 2,
      lastPage: 4,
    });
    expect(() => requireArxivPageRange("0", "4")).toThrow("first-page");
    expect(() => requireArxivPageRange("4", "3")).toThrow("last-page");
    expect(requireArxivMaxChars(undefined)).toBe(40000);
    expect(() => requireArxivMaxChars("999")).toThrow("max-chars");
    expect(
      arxivArtifactFilename({
        id: "1706.03762v7",
        title: "Attention / Is: All? You Need",
      }),
    ).toBe("1706.03762v7-Attention-Is-All-You-Need.pdf");
  });

  it("registers arxiv read as a source-level fulltext command", () => {
    expect(resolveCommand("arxiv", "read")?.command.capabilities).toEqual([
      "http.fetch",
      "http.download",
      "subprocess.exec",
      "scholar.fulltext",
      "scholar.pdf",
    ]);
    expect(resolveCommand("arxiv", "read")?.command.minimum_capability).toBe(
      "subprocess.exec",
    );
    expect(resolveCommand("arxiv", "read")?.command.executables).toEqual([
      "pdftotext",
    ]);
  });

  it("decodes entities and parses Atom entries", () => {
    expect(decodeArxivEntities("A &amp; B &lt; C")).toBe("A & B < C");
    expect(
      parseArxivEntries(`
        <feed>
          <entry>
            <id>http://arxiv.org/abs/1706.03762v7</id>
            <title> Attention   Is All You Need </title>
            <summary> We present   transformers. </summary>
            <published>2017-06-12T17:57:34Z</published>
            <updated>2023-08-02T00:00:00Z</updated>
            <author><name>Alice &amp; Bob</name></author>
            <author><name>Carol</name></author>
            <arxiv:primary_category term="cs.CL" />
            <category term="cs.CL" />
            <category term="cs.LG" />
            <arxiv:comment>15 pages</arxiv:comment>
            <link title="pdf" href="https://arxiv.org/pdf/1706.03762" rel="related" />
          </entry>
        </feed>
      `),
    ).toEqual([
      {
        id: "1706.03762",
        title: "Attention Is All You Need",
        authors: "Alice & Bob, Carol",
        abstract: "We present transformers.",
        published: "2017-06-12",
        updated: "2023-08-02",
        primary_category: "cs.CL",
        categories: "cs.CL, cs.LG",
        comment: "15 pages",
        pdf: "https://arxiv.org/pdf/1706.03762",
        url: "https://arxiv.org/abs/1706.03762",
      },
    ]);
  });
});
