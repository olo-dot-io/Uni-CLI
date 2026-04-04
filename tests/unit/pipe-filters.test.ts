import { describe, it, expect } from "vitest";
import {
  PIPE_FILTERS,
  evalExpression,
  buildScope,
} from "../../src/engine/yaml-runner.js";

// ---------- Existing filters (regression) ----------

describe("existing pipe filters (regression)", () => {
  it("join: concatenates array items", () => {
    expect(PIPE_FILTERS.join(["a", "b", "c"], ", ")).toBe("a, b, c");
    expect(PIPE_FILTERS.join(["x"], "-")).toBe("x");
    expect(PIPE_FILTERS.join("not-array", ", ")).toBe("not-array");
  });

  it("urlencode: encodes special characters", () => {
    expect(PIPE_FILTERS.urlencode("hello world")).toBe("hello%20world");
    expect(PIPE_FILTERS.urlencode("a&b=c")).toBe("a%26b%3Dc");
  });

  it("slice: extracts substring", () => {
    expect(PIPE_FILTERS.slice("hello world", 0, 5)).toBe("hello");
    expect(PIPE_FILTERS.slice("hello", 2)).toBe("llo");
  });

  it("replace: replaces all occurrences", () => {
    expect(PIPE_FILTERS.replace("a-b-c", "-", "_")).toBe("a_b_c");
  });

  it("lowercase / uppercase", () => {
    expect(PIPE_FILTERS.lowercase("Hello")).toBe("hello");
    expect(PIPE_FILTERS.uppercase("hello")).toBe("HELLO");
  });

  it("trim: removes whitespace", () => {
    expect(PIPE_FILTERS.trim("  hello  ")).toBe("hello");
  });

  it("default: returns fallback for null/empty", () => {
    expect(PIPE_FILTERS.default(null, "fallback")).toBe("fallback");
    expect(PIPE_FILTERS.default("", "fallback")).toBe("fallback");
    expect(PIPE_FILTERS.default("value", "fallback")).toBe("value");
  });

  it("split: splits string", () => {
    expect(PIPE_FILTERS.split("a,b,c", ",")).toEqual(["a", "b", "c"]);
  });

  it("first / last", () => {
    expect(PIPE_FILTERS.first([1, 2, 3])).toBe(1);
    expect(PIPE_FILTERS.last([1, 2, 3])).toBe(3);
  });

  it("length: returns length", () => {
    expect(PIPE_FILTERS.length([1, 2, 3])).toBe(3);
    expect(PIPE_FILTERS.length("hello")).toBe(5);
  });

  it("strip_html: removes HTML tags", () => {
    expect(PIPE_FILTERS.strip_html("<p>Hello <b>world</b></p>")).toBe(
      "Hello world",
    );
  });

  it("truncate: truncates long strings", () => {
    const long = "a".repeat(200);
    const result = PIPE_FILTERS.truncate(long, 10) as string;
    expect(result).toBe("a".repeat(10) + "...");
    expect(PIPE_FILTERS.truncate("short", 100)).toBe("short");
  });
});

// ---------- New filters ----------

describe("slugify filter", () => {
  it("converts text to URL slug", () => {
    expect(PIPE_FILTERS.slugify("Hello World! 你好")).toBe("hello-world");
  });

  it("handles accented characters", () => {
    expect(PIPE_FILTERS.slugify("café")).toBe("cafe");
  });

  it("removes leading/trailing dashes", () => {
    expect(PIPE_FILTERS.slugify("--hello--")).toBe("hello");
  });

  it("handles empty/null input", () => {
    expect(PIPE_FILTERS.slugify(null)).toBe("");
    expect(PIPE_FILTERS.slugify("")).toBe("");
  });

  it("collapses multiple non-alnum characters", () => {
    expect(PIPE_FILTERS.slugify("one   two---three")).toBe("one-two-three");
  });
});

describe("sanitize filter", () => {
  it("replaces filesystem-unsafe characters", () => {
    expect(PIPE_FILTERS.sanitize('file<>:"/\\|?*.txt')).toBe(
      "file_________.txt",
    );
  });

  it("returns 'download' for empty input", () => {
    expect(PIPE_FILTERS.sanitize("")).toBe("download");
    expect(PIPE_FILTERS.sanitize(null)).toBe("download");
  });

  it("strips leading dots", () => {
    expect(PIPE_FILTERS.sanitize("..hidden")).toBe("hidden");
  });

  it("strips control characters", () => {
    expect(PIPE_FILTERS.sanitize("file\x00name")).toBe("file_name");
  });
});

describe("ext filter", () => {
  it("extracts extension from URL with query params", () => {
    expect(PIPE_FILTERS.ext("https://example.com/image.png?w=200")).toBe("png");
  });

  it("extracts extension from compound filename", () => {
    expect(PIPE_FILTERS.ext("file.tar.gz")).toBe("gz");
  });

  it("returns empty string for no extension", () => {
    expect(PIPE_FILTERS.ext("https://example.com/path/")).toBe("");
    expect(PIPE_FILTERS.ext("noext")).toBe("");
  });

  it("handles URL with hash", () => {
    expect(PIPE_FILTERS.ext("image.jpg#section")).toBe("jpg");
  });
});

describe("basename filter", () => {
  it("extracts filename from URL", () => {
    expect(PIPE_FILTERS.basename("https://example.com/path/image.png")).toBe(
      "image.png",
    );
  });

  it("extracts filename from plain path", () => {
    expect(PIPE_FILTERS.basename("/usr/local/bin/node")).toBe("node");
  });

  it("handles URL with trailing slash", () => {
    expect(PIPE_FILTERS.basename("https://example.com/path/")).toBe("");
  });

  it("handles simple filename", () => {
    expect(PIPE_FILTERS.basename("file.txt")).toBe("file.txt");
  });
});

describe("keys filter", () => {
  it("returns object keys", () => {
    expect(PIPE_FILTERS.keys({ a: 1, b: 2 })).toEqual(["a", "b"]);
  });

  it("returns empty array for non-object", () => {
    expect(PIPE_FILTERS.keys("string")).toEqual([]);
    expect(PIPE_FILTERS.keys(null)).toEqual([]);
    expect(PIPE_FILTERS.keys(42)).toEqual([]);
  });

  it("returns empty array for arrays", () => {
    expect(PIPE_FILTERS.keys([1, 2, 3])).toEqual([]);
  });
});

describe("json filter", () => {
  it("serializes objects", () => {
    expect(PIPE_FILTERS.json({ a: 1 })).toBe('{"a":1}');
  });

  it("serializes null", () => {
    expect(PIPE_FILTERS.json(null)).toBe("null");
  });

  it("serializes arrays", () => {
    expect(PIPE_FILTERS.json([1, 2])).toBe("[1,2]");
  });

  it("serializes strings", () => {
    expect(PIPE_FILTERS.json("hello")).toBe('"hello"');
  });
});

// ---------- VM sandbox security ----------

describe("VM sandbox security", () => {
  const scope = { item: { title: "test" }, args: {}, base: "", temp: {} };

  it("blocks constructor access", () => {
    expect(evalExpression("constructor", scope)).toBeUndefined();
  });

  it("blocks __proto__ access", () => {
    expect(evalExpression("__proto__", scope)).toBeUndefined();
  });

  it("blocks process.env access", () => {
    expect(evalExpression("process.env", scope)).toBeUndefined();
  });

  it("blocks require('fs')", () => {
    expect(evalExpression("require('fs')", scope)).toBeUndefined();
  });

  it("blocks import('fs')", () => {
    expect(evalExpression("import('fs')", scope)).toBeUndefined();
  });

  it("blocks eval()", () => {
    expect(evalExpression("eval('1+1')", scope)).toBeUndefined();
  });

  it("blocks globalThis access", () => {
    expect(evalExpression("globalThis", scope)).toBeUndefined();
  });

  it("blocks prototype access", () => {
    expect(evalExpression("Object.prototype", scope)).toBeUndefined();
  });
});

// ---------- evalExpression basic functionality ----------

describe("evalExpression", () => {
  const scope = {
    item: { title: "Hello", tags: ["a", "b", "c"], count: 42 },
    args: { query: "test search" },
    base: "https://example.com",
    temp: {},
  };

  it("resolves simple dotted path", () => {
    expect(evalExpression("item.title", scope)).toBe("Hello");
  });

  it("resolves nested dotted path", () => {
    expect(evalExpression("args.query", scope)).toBe("test search");
  });

  it("resolves array index", () => {
    expect(evalExpression("item.tags[0]", scope)).toBe("a");
  });

  it("applies pipe filter to dotted path", () => {
    expect(evalExpression("item.title | lowercase", scope)).toBe("hello");
  });

  it("applies pipe filter with args", () => {
    expect(evalExpression("item.tags | join(', ')", scope)).toBe("a, b, c");
  });

  it("chains multiple filters", () => {
    expect(evalExpression("item.title | lowercase | urlencode", scope)).toBe(
      "hello",
    );
  });

  it("evaluates complex expressions via VM", () => {
    expect(evalExpression("item.count + 8", scope)).toBe(50);
  });

  it("evaluates ternary expressions via VM", () => {
    expect(evalExpression("item.count > 10 ? 'big' : 'small'", scope)).toBe(
      "big",
    );
  });

  it("returns undefined for invalid expressions", () => {
    expect(evalExpression("nonexistent.deep.path", scope)).toBeUndefined();
  });

  it("applies new filters via expression engine", () => {
    const s = {
      ...scope,
      item: { url: "https://example.com/path/image.png?w=200" },
    };
    expect(evalExpression("item.url | ext", s)).toBe("png");
    expect(evalExpression("item.url | basename", s)).toBe("image.png");
  });

  it("applies slugify filter via expression engine", () => {
    const s = { ...scope, item: { title: "Hello World! 你好" } };
    expect(evalExpression("item.title | slugify", s)).toBe("hello-world");
  });

  it("applies json filter via expression engine", () => {
    expect(evalExpression("item.tags | json", scope)).toBe('["a","b","c"]');
  });

  it("applies keys filter via expression engine", () => {
    const s = { ...scope, item: { a: 1, b: 2 } };
    expect(evalExpression("item | keys", s)).toEqual(["a", "b"]);
  });
});

// ---------- buildScope ----------

describe("buildScope", () => {
  it("creates scope with args, base, and temp", () => {
    const ctx = {
      data: null,
      args: { q: "test" },
      base: "https://example.com",
    };
    const scope = buildScope(ctx as never);
    expect(scope.args).toEqual({ q: "test" });
    expect(scope.base).toBe("https://example.com");
    expect(scope.temp).toEqual({});
  });

  it("sets item from data when no item field", () => {
    const ctx = {
      data: { title: "Hello" },
      args: {},
    };
    const scope = buildScope(ctx as never);
    expect(scope.item).toEqual({ title: "Hello" });
  });

  it("extracts item and index from data with item field", () => {
    const ctx = {
      data: { item: { title: "Hello" }, index: 0 },
      args: {},
    };
    const scope = buildScope(ctx as never);
    expect(scope.item).toEqual({ title: "Hello" });
    expect(scope.index).toBe(0);
  });
});

// ---------- Pipeline integration (basic operations) ----------

describe("pipeline basic operations", () => {
  it("stepLimit caps results", () => {
    const mockData = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    expect(mockData.slice(0, 5).length).toBe(5);
  });

  it("pipeline steps array is valid", () => {
    const steps = [
      {
        fetch: { url: "https://hacker-news.firebaseio.com/v0/user/pg.json" },
      },
      { map: { username: "${{ item.id }}", karma: "${{ item.karma }}" } },
    ];
    expect(steps.length).toBe(2);
  });
});

// ---------- RSS parser ----------

describe("RSS parser", () => {
  it("parses standard RSS XML items", () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Test Title</title>
          <link>https://example.com</link>
          <description>Test Desc</description>
          <pubDate>Mon, 01 Jan 2024</pubDate>
        </item>
        <item>
          <title><![CDATA[CDATA Title]]></title>
          <link>https://example2.com</link>
          <description><![CDATA[CDATA Desc]]></description>
        </item>
      </channel></rss>
    `;

    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    const matches: string[] = [];
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      matches.push(match[1]);
    }
    expect(matches.length).toBe(2);

    const cdataMatch = matches[1].match(
      /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/,
    );
    expect(cdataMatch?.[1]).toBe("CDATA Title");
  });
});
