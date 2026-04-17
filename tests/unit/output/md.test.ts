import { describe, it, expect } from "vitest";
import { makeEnvelope, makeError } from "../../../src/output/envelope.js";
import { renderMd } from "../../../src/output/md.js";

describe("renderMd", () => {
  it("success with array data — frontmatter, sections, pagination", () => {
    const env = makeEnvelope(
      {
        command: "twitter.search",
        duration_ms: 1234,
        adapter_version: "2026.04",
        surface: "web",
        operator: "cdp-native",
        pagination: { next_cursor: "abc123", has_more: true },
      },
      [
        { id: "1", title: "Hello world", author: "alice", likes: 42 },
        { id: "2", title: "Second tweet", author: "bob", likes: 7 },
      ],
    );
    expect(renderMd(env)).toMatchInlineSnapshot(`
      "---
      ok: true
      schema_version: "2"
      command: twitter.search
      duration_ms: 1234
      count: 2
      surface: web
      adapter_version: 2026.04
      operator: cdp-native
      next_cursor: abc123
      has_more: true
      ---

      ## Data

      ### 1 · Hello world

      - **id**: 1
      - **title**: Hello world
      - **author**: alice
      - **likes**: 42

      ### 2 · Second tweet

      - **id**: 2
      - **title**: Second tweet
      - **author**: bob
      - **likes**: 7

      ## Context

      - **adapter_version**: 2026.04
      - **surface**: web
      - **operator**: cdp-native
      - **next_cursor**: abc123
      - **has_more**: true

      ## Next Actions

      - Fetch next page with cursor: \`abc123\`
      "
    `);
  });

  it("success with object data — flat bullets, no count/Context/Next Actions", () => {
    const env = makeEnvelope(
      { command: "twitter.whoami", duration_ms: 50 },
      { authenticated: true, user: { handle: "alice", id: 123 } },
    );
    expect(renderMd(env)).toMatchInlineSnapshot(`
      "---
      ok: true
      schema_version: "2"
      command: twitter.whoami
      duration_ms: 50
      ---

      ## Data

      - **authenticated**: true
      - **user**: {"handle":"alice","id":123}
      "
    `);
  });

  it("error envelope with full fields — Error/Suggestion/Alternatives, no Data", () => {
    const env = makeError(
      { command: "twitter.search", duration_ms: 567, surface: "web" },
      {
        code: "selector_miss",
        message: "Element .tweet-title not found after 5000ms",
        adapter_path: "src/adapters/twitter/search.yaml",
        step: 3,
        suggestion: "Selector changed — run `unicli repair twitter search`",
        retryable: false,
        alternatives: ["twitter.list", "twitter.user"],
      },
    );
    expect(renderMd(env)).toMatchInlineSnapshot(`
      "---
      ok: false
      schema_version: "2"
      command: twitter.search
      duration_ms: 567
      surface: web
      ---

      ## Error

      - **code**: selector_miss
      - **message**: Element .tweet-title not found after 5000ms
      - **adapter_path**: src/adapters/twitter/search.yaml
      - **step**: 3
      - **retryable**: false

      ## Suggestion

      Selector changed — run \`unicli repair twitter search\`

      ## Alternatives

      - \`twitter.list\`
      - \`twitter.user\`
      "
    `);
  });

  it("empty data array — count=0, _(no data)_, no Context/Next Actions", () => {
    const env = makeEnvelope(
      { command: "twitter.search", duration_ms: 10 },
      [],
    );
    expect(renderMd(env)).toMatchInlineSnapshot(`
      "---
      ok: true
      schema_version: "2"
      command: twitter.search
      duration_ms: 10
      count: 0
      ---

      ## Data

      _(no data)_
      "
    `);
  });

  it("renders circular reference as [Circular]", () => {
    type Circ = { id: string; parent?: Circ };
    const root: Circ = { id: "root" };
    root.parent = root; // self-cycle
    const env = makeEnvelope({ command: "t.c", duration_ms: 1 }, [
      { id: "x", ref: root },
    ]);
    // Should not throw
    const out = renderMd(env);
    expect(out).toContain("[Circular]");
    expect(out).not.toContain("Converting circular structure");
  });

  it("shared (non-cyclic) references render normally, not as [Circular]", () => {
    const shared = { x: 1 };
    const env = makeEnvelope({ command: "t.s", duration_ms: 1 }, [
      { id: "a", ref: shared },
      { id: "b", ref: shared },
    ]);
    const out = renderMd(env);
    expect(out).not.toContain("[Circular]");
    // both items should render the shared object
    expect(out.match(/\{"x":1\}/g)?.length ?? 0).toBe(2);
  });

  // ── 8 new tests from round-2 code review ────────────────────────────────

  it("renders error without suggestion — ## Suggestion section absent", () => {
    const env = makeError(
      { command: "gh.issues", duration_ms: 10 },
      { code: "auth_error", message: "Not authenticated" },
    );
    const out = renderMd(env);
    expect(out).toContain("## Error");
    expect(out).not.toContain("## Suggestion");
  });

  it("renders error with empty alternatives array — ## Alternatives absent", () => {
    const env = makeError(
      { command: "gh.issues", duration_ms: 10 },
      { code: "not_found", message: "Repo not found", alternatives: [] },
    );
    const out = renderMd(env);
    expect(out).toContain("## Error");
    expect(out).not.toContain("## Alternatives");
  });

  it("renders success with has_more=false + next_cursor — no Next Actions, cursor in Context", () => {
    const env = makeEnvelope(
      {
        command: "gh.list",
        duration_ms: 20,
        pagination: { next_cursor: "abc", has_more: false },
      },
      [{ id: "1", title: "item" }],
    );
    const out = renderMd(env);
    expect(out).not.toContain("## Next Actions");
    expect(out).toContain("next_cursor");
  });

  it("sanitizes leading --- in data string values", () => {
    const env = makeEnvelope({ command: "t.d", duration_ms: 1 }, [
      { id: "x", note: "---\nsecret: 42" },
    ]);
    const out = renderMd(env);
    // The note value must not produce a bare line-start `---` (it should be
    // collapsed to a single line with a space, so "--- secret: 42" or similar).
    const lines = out.split("\n");
    // No line outside the frontmatter fences should be exactly `---`
    const frontmatterFences = lines.reduce<number[]>((acc, line, i) => {
      if (line === "---") acc.push(i);
      return acc;
    }, []);
    // Exactly two frontmatter fence lines (opening + closing).
    expect(frontmatterFences).toHaveLength(2);
  });

  it("sanitizes embedded newlines in titles — no new ## header injected", () => {
    const env = makeEnvelope({ command: "t.t", duration_ms: 1 }, [
      { title: "Hello\n## Injected", id: "x" },
    ]);
    const out = renderMd(env);
    // The ### header for the item must remain a single line (no injected ## header).
    expect(out).not.toMatch(/^## Injected/m);
    // The item header line should contain the sanitized title on one line.
    expect(out).toMatch(/^### 1 · Hello/m);
  });

  it("handles BigInt values — does not throw, output contains value", () => {
    const env = makeEnvelope({ command: "t.b", duration_ms: 1 }, [
      { amount: 42n },
    ]);
    // Must not throw.
    let out: string;
    expect(() => {
      out = renderMd(env);
    }).not.toThrow();
    // Output should contain the BigInt representation.
    expect(out!).toMatch(/42n|\[unserializable\]/);
  });

  it("handles objects with throwing toJSON — does not throw, output contains [unserializable]", () => {
    const bad = {
      toJSON: () => {
        throw new Error("boom");
      },
    };
    const env = makeEnvelope({ command: "t.j", duration_ms: 1 }, [{ x: bad }]);
    // Must not throw.
    let out: string;
    expect(() => {
      out = renderMd(env);
    }).not.toThrow();
    expect(out!).toContain("[unserializable]");
  });

  it("adapter_version with embedded newline does not break frontmatter", () => {
    const env = makeEnvelope(
      {
        command: "t.v",
        duration_ms: 1,
        adapter_version: "1.0\n---\ninjected: true",
      },
      [],
    );
    const out = renderMd(env);
    const lines = out.split("\n");
    // Exactly two `---` fences for the frontmatter block (opening + closing).
    // If the newline were preserved, a third bare `---` would appear.
    const fenceLines = lines.filter((l) => l === "---");
    expect(fenceLines).toHaveLength(2);
    // The adapter_version value must appear on a single line (newlines collapsed).
    const avLine = lines.find((l) => l.startsWith("adapter_version:"));
    expect(avLine).toBeDefined();
    // The collapsed line contains both parts separated by a space, on ONE line.
    expect(avLine).toContain("1.0");
    // No standalone `injected: true` line should exist as its own YAML key.
    expect(lines).not.toContain("injected: true");
  });
});
