/**
 * projection.test.ts — `--select` / `--fields` / `--pluck` externalization.
 *
 * These flags let agents project kernel output before the formatter runs,
 * replacing `| jq` / `| awk` pipelines. The priority order (pluck > select
 * > fields) is asserted here, plus each flag's individual behavior.
 */

import { describe, it, expect, vi } from "vitest";
import {
  applyProjection,
  renderPluck,
  pluckRow,
} from "../../../src/output/projection.js";

const ROWS = [
  { title: "hello", url: "https://a", score: 1 },
  { title: "world", url: "https://b", score: 2 },
  { title: "agents", url: "https://c", score: 3 },
];

describe("applyProjection — --select (JSONPath)", () => {
  it("'$[0].title' returns a single-row array with the first title", () => {
    const p = applyProjection(ROWS, { select: "$[0].title" });
    expect(p.pluckMode).toBe(false);
    expect(p.results).toEqual(["hello"]);
  });

  it("'$[*].title' returns every title", () => {
    const p = applyProjection(ROWS, { select: "$[*].title" });
    expect(p.results).toEqual(["hello", "world", "agents"]);
  });

  it("'$[?(@.score>1)]' filters by predicate", () => {
    const p = applyProjection(ROWS, { select: "$[?(@.score>1)]" });
    expect(p.results).toHaveLength(2);
    expect((p.results[0] as { title: string }).title).toBe("world");
  });

  it("no matches → empty array (not null/undefined)", () => {
    const p = applyProjection(ROWS, { select: "$[10].title" });
    expect(p.results).toEqual([]);
  });
});

describe("applyProjection — --fields (column projection)", () => {
  it("comma-separated list becomes columns override", () => {
    const p = applyProjection(ROWS, { fields: "title,score" });
    expect(p.columns).toEqual(["title", "score"]);
    expect(p.results).toBe(ROWS); // unchanged — columns applied by formatter
  });

  it("trims whitespace and drops empty entries", () => {
    const p = applyProjection(ROWS, { fields: " title , , score , " });
    expect(p.columns).toEqual(["title", "score"]);
  });
});

describe("applyProjection — --pluck (single-field stream)", () => {
  it("pluckMode=true short-circuits formatter", () => {
    const p = applyProjection(ROWS, { pluck: "url" });
    expect(p.pluckMode).toBe(true);
    expect(p.results).toBe(ROWS);
  });

  it("renderPluck emits one value per line, no header", () => {
    const out = renderPluck(ROWS, "title");
    expect(out).toBe("hello\nworld\nagents");
  });

  it("pluckRow serializes nested objects as one-line JSON", () => {
    expect(pluckRow({ nested: { a: 1 } }, "nested")).toBe('{"a":1}');
  });

  it("pluckRow returns empty string for missing / null fields", () => {
    expect(pluckRow({ title: "x" }, "missing")).toBe("");
    expect(pluckRow({ title: null }, "title")).toBe("");
    expect(pluckRow(null, "title")).toBe("");
  });
});

describe("applyProjection — flag precedence", () => {
  it("pluck beats select and emits a single warning", () => {
    const warn = vi.fn();
    const p = applyProjection(ROWS, { pluck: "title", select: "$[0]" }, warn);
    expect(p.pluckMode).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0] as string;
    expect(msg).toContain("--pluck");
    expect(msg).toContain("wins");
  });

  it("select beats fields", () => {
    const warn = vi.fn();
    const p = applyProjection(
      ROWS,
      { select: "$[*].title", fields: "x,y" },
      warn,
    );
    expect(p.pluckMode).toBe(false);
    expect(p.results).toEqual(["hello", "world", "agents"]);
    expect(p.columns).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no flags → pass-through", () => {
    const warn = vi.fn();
    const p = applyProjection(ROWS, {}, warn);
    expect(p.results).toBe(ROWS);
    expect(p.columns).toBeUndefined();
    expect(p.pluckMode).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
