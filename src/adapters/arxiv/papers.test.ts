import { describe, expect, it } from "vitest";
import {
  decodeArxivEntities,
  parseArxivEntries,
  requireArxivAuthor,
  requireArxivCategory,
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
