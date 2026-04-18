import { describe, it, expect } from "vitest";
import {
  classifyArg,
  processFile,
  detectPaginated,
} from "../../../scripts/migrate-add-kind.js";

describe("classifyArg — rule engine", () => {
  it("rule 2: `url` name → format: uri", () => {
    const a = classifyArg("x", "y", "url", "Video URL", new Set());
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") {
      expect(a.lines).toEqual(["format: uri"]);
      expect(a.rule).toBe("rule2-url-name");
    }
  });

  it("rule 2: description starting with `URL` → format: uri", () => {
    const a = classifyArg("x", "y", "link", "URL to fetch", new Set());
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") {
      expect(a.lines).toEqual(["format: uri"]);
      expect(a.rule).toBe("rule2-url-desc");
    }
  });

  it("rule 3: `output` / `path` / `cookies_file` → x-unicli-kind: path", () => {
    for (const n of ["output", "path", "cookies_file", "dest_dir"]) {
      const a = classifyArg("x", "y", n, "Output directory", new Set());
      expect(a.kind).toBe("annotate");
      if (a.kind === "annotate") {
        expect(a.lines).toEqual(["x-unicli-kind: path"]);
        expect(a.rule).toBe("rule3-path-like");
      }
    }
  });

  it("rule 4: `id` without URL in desc → x-unicli-kind: id", () => {
    const a = classifyArg("x", "y", "id", "Story ID", new Set());
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") {
      expect(a.lines).toEqual(["x-unicli-kind: id"]);
      expect(a.rule).toBe("rule4-id");
    }
  });

  it("rule 4 skipped when `id` description mentions URL — override takes over", () => {
    // zhihu/answers/id is in the Group A override table
    const a = classifyArg(
      "zhihu",
      "answers",
      "id",
      "User URL token",
      new Set(),
    );
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") {
      expect(a.rule).toBe("rule0-override");
      expect(a.lines).toEqual(["x-unicli-kind: id", "x-unicli-accepts: [url]"]);
    }
  });

  it("rule 5: `email` → format: email", () => {
    const a = classifyArg("x", "y", "email", "User email", new Set());
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") expect(a.lines).toEqual(["format: email"]);
  });

  it("rule 6: `created_date` → format: date-time", () => {
    const a = classifyArg("x", "y", "created_date", "Date", new Set());
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") expect(a.lines).toEqual(["format: date-time"]);
  });

  it("skip: already annotated with `format:`", () => {
    const a = classifyArg(
      "x",
      "y",
      "url",
      "Video URL",
      new Set(["name", "type", "format"]),
    );
    expect(a.kind).toBe("skip");
    if (a.kind === "skip") expect(a.reason).toBe("already-annotated");
  });

  it("skip: freeform arg (query, limit)", () => {
    const a = classifyArg("x", "y", "query", "Search query", new Set());
    expect(a.kind).toBe("skip");
  });

  it("override Group B: twitter/quotes/url → format: uri + accepts id", () => {
    const a = classifyArg(
      "twitter",
      "quotes",
      "url",
      "Tweet URL or ID",
      new Set(),
    );
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") {
      expect(a.lines).toEqual(["format: uri", "x-unicli-accepts: [id]"]);
      expect(a.rule).toBe("rule0-override");
    }
  });

  it("override Group C: yollomi/restore/image → path + accepts url", () => {
    const a = classifyArg(
      "yollomi",
      "restore",
      "image",
      "Image URL or local path",
      new Set(),
    );
    expect(a.kind).toBe("annotate");
    if (a.kind === "annotate") {
      expect(a.lines).toEqual([
        "x-unicli-kind: path",
        "x-unicli-accepts: [url]",
      ]);
    }
  });
});

describe("processFile — YAML surgery", () => {
  it("inserts annotations at correct indent without reflowing other lines", () => {
    const src = `site: demo
name: fetch
description: Demo command

args:
  url:
    type: str
    required: true
    description: Video URL to fetch
  output:
    type: str
    default: "./out.mp4"
    description: Output path

pipeline:
  - fetch: { url: "https://example.com" }
`;
    const r = processFile("/tmp/demo.yaml", src);
    expect(r.argsMigrated).toBe(2);
    expect(r.newSrc).toBeDefined();
    expect(r.newSrc).toContain(
      "description: Video URL to fetch\n    format: uri",
    );
    expect(r.newSrc).toContain(
      "description: Output path\n    x-unicli-kind: path",
    );
    // Lines above/below args must be byte-identical.
    expect(r.newSrc!.startsWith("site: demo\nname: fetch\n")).toBe(true);
    expect(r.newSrc).toContain(
      'pipeline:\n  - fetch: { url: "https://example.com" }\n',
    );
  });

  it("override for zhihu/answers/id adds both kind and accepts", () => {
    const src = `site: zhihu
name: answers
description: List answers

args:
  id:
    required: true
    positional: true
    description: User URL token

pipeline: []
`;
    const r = processFile("/tmp/zhihu-answers.yaml", src);
    expect(r.argsMigrated).toBe(1);
    expect(r.overridesApplied).toBe(1);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].group).toBe("A");
    expect(r.newSrc).toContain("x-unicli-kind: id");
    expect(r.newSrc).toContain("x-unicli-accepts: [url]");
  });

  it("is idempotent — second run produces no diff", () => {
    const src = `site: demo
name: fetch
args:
  url:
    type: str
    description: Fetch URL
pipeline: []
`;
    const first = processFile("/tmp/demo.yaml", src);
    expect(first.newSrc).toBeDefined();
    const second = processFile("/tmp/demo.yaml", first.newSrc!);
    expect(second.newSrc).toBeUndefined();
    expect(second.argsMigrated).toBe(0);
    expect(second.argsSkipped).toBe(1);
  });

  it("preserves adjacent comments", () => {
    const src = `site: demo
name: fetch
# keep this comment above args
args:
  # keep this comment inside args
  url:
    type: str
    description: Fetch URL
    # trailing comment inside arg block
pipeline: []
`;
    const r = processFile("/tmp/demo.yaml", src);
    expect(r.newSrc).toBeDefined();
    expect(r.newSrc).toContain("# keep this comment above args");
    expect(r.newSrc).toContain("# keep this comment inside args");
    expect(r.newSrc).toContain("# trailing comment inside arg block");
    expect(r.newSrc).toContain("format: uri");
  });

  it("leaves freeform args untouched", () => {
    const src = `site: demo
name: search
args:
  query:
    type: str
    description: Search query
  limit:
    type: int
    default: 10
    description: Number of results
pipeline: []
`;
    const r = processFile("/tmp/demo.yaml", src);
    expect(r.argsMigrated).toBe(0);
    expect(r.argsSkipped).toBe(2);
    expect(r.newSrc).toBeUndefined();
  });

  it("skips args that already declare format:", () => {
    const src = `site: demo
name: fetch
args:
  url:
    type: str
    description: Already annotated
    format: uri
pipeline: []
`;
    const r = processFile("/tmp/demo.yaml", src);
    expect(r.argsMigrated).toBe(0);
    expect(r.newSrc).toBeUndefined();
  });
});

describe("detectPaginated", () => {
  it("returns true when pipeline references next_cursor", () => {
    const src = `site: x
name: y
pipeline:
  - fetch:
      url: foo
  - set:
      next_cursor: "\${{ data.meta.next_cursor }}"
`;
    expect(detectPaginated(src)).toBe(true);
  });

  it("returns false for non-paginated commands", () => {
    const src = `site: x
name: y
pipeline:
  - fetch:
      url: foo
  - limit: 20
`;
    expect(detectPaginated(src)).toBe(false);
  });
});
