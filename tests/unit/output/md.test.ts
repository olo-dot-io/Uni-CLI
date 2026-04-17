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
});
