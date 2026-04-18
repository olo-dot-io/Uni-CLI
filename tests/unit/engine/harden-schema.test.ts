/**
 * Schema-driven hardening tests — v0.213.3 replaces the regex-over-names
 * `looksLike*` heuristics with ajv format-assertion + `x-unicli-kind`
 * dispatch. Each declared kind / format fails closed.
 *
 * No ajv mocks — these tests exercise the real validator built at first
 * call.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hardenArgs, InputHardeningError } from "../../../src/engine/harden.js";
import type { AdapterArg } from "../../../src/types.js";

function trycatch(
  args: Record<string, unknown>,
  schema: AdapterArg[],
):
  | { ok: true; warnings: string[] }
  | { ok: false; argName: string; msg: string; suggestion: string } {
  try {
    const r = hardenArgs(args, schema);
    return { ok: true, warnings: r.warnings };
  } catch (err) {
    if (err instanceof InputHardeningError) {
      return {
        ok: false,
        argName: err.argName,
        msg: err.message,
        suggestion: err.suggestion,
      };
    }
    throw err;
  }
}

describe("hardenArgs — format: uri (draft-2020-12 format-assertion)", () => {
  const schema: AdapterArg[] = [{ name: "target", type: "str", format: "uri" }];

  it("accepts a valid https URL", () => {
    const r = trycatch({ target: "https://example.com/a?b=c" }, schema);
    expect(r.ok).toBe(true);
  });

  it('rejects "not a url"', () => {
    const r = trycatch({ target: "not a url" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.argName).toBe("target");
      expect(r.msg).toMatch(/uri/);
      expect(r.suggestion).toMatch(/format/);
    }
  });

  it("warns (does not reject) on double-encoded URL", () => {
    const r = trycatch({ target: "https://example.com/%2520" }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => /double-URL-encoded/.test(w))).toBe(true);
    }
  });
});

describe('hardenArgs — x-unicli-kind: "path"', () => {
  const schema: AdapterArg[] = [
    { name: "dst", type: "str", "x-unicli-kind": "path" },
  ];

  it("accepts a relative CWD path", () => {
    const r = trycatch({ dst: "./output/x.txt" }, schema);
    expect(r.ok).toBe(true);
  });

  it("accepts an absolute $HOME path", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    if (!home) return;
    const r = trycatch({ dst: `${home}/unicli-test.txt` }, schema);
    expect(r.ok).toBe(true);
  });

  it('rejects "../../etc/passwd" when CWD is outside $HOME', () => {
    // Force CWD to a tmpdir outside $HOME so the relative escape actually
    // lands outside the sandbox.
    const outside = mkdtempSync(join(tmpdir(), "unicli-harden-outside-"));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    try {
      // Simulate a workspace where the user's actions can't reach $HOME.
      process.chdir(outside);
      process.env.HOME = outside;
      const r = trycatch({ dst: "../../etc/passwd" }, schema);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.argName).toBe("dst");
        expect(r.msg).toMatch(/escapes CWD/);
      }
    } finally {
      process.chdir(origCwd);
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a path containing a NUL byte (via the control-char gate)", () => {
    const r = trycatch({ dst: "./good\0path" }, schema);
    expect(r.ok).toBe(false);
    // NUL is caught by the always-on control-char gate before the path
    // validator sees the value — either message is a valid rejection.
    if (!r.ok) {
      expect(r.msg).toMatch(/control characters|NUL byte/);
    }
  });
});

describe('hardenArgs — x-unicli-kind: "adapter-ref"', () => {
  const schema: AdapterArg[] = [
    { name: "ref", type: "str", "x-unicli-kind": "adapter-ref" },
  ];

  it('accepts "hackernews/top"', () => {
    const r = trycatch({ ref: "hackernews/top" }, schema);
    expect(r.ok).toBe(true);
  });

  it('rejects "hackernews" (missing slash)', () => {
    const r = trycatch({ ref: "hackernews" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toMatch(/<site>\/<command>/);
  });

  it('rejects "a/b/c" (extra slash)', () => {
    const r = trycatch({ ref: "a/b/c" }, schema);
    expect(r.ok).toBe(false);
  });

  it("rejects uppercase", () => {
    const r = trycatch({ ref: "HackerNews/top" }, schema);
    expect(r.ok).toBe(false);
  });
});

describe('hardenArgs — x-unicli-kind: "selector"', () => {
  const schema: AdapterArg[] = [
    { name: "sel", type: "str", "x-unicli-kind": "selector" },
  ];

  it("accepts a plain CSS selector", () => {
    const r = trycatch({ sel: "a.link[href]" }, schema);
    expect(r.ok).toBe(true);
  });

  it('rejects "<script>"', () => {
    const r = trycatch({ sel: "<script>alert(1)</script>" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toMatch(/<script/);
  });

  it("rejects a backtick", () => {
    const r = trycatch({ sel: "a[data-x=`1`]" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toMatch(/backtick/);
  });
});

describe('hardenArgs — x-unicli-kind: "shell-safe"', () => {
  const schema: AdapterArg[] = [
    { name: "raw", type: "str", "x-unicli-kind": "shell-safe" },
  ];

  it("accepts a plain literal", () => {
    const r = trycatch({ raw: "hello-world.v2_final" }, schema);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["$USER", "$"],
    ["`whoami`", "`"],
    [";rm -rf /", ";"],
    ["|cat", "|"],
    ["&&ls", "&"],
    [">/tmp/leak", ">"],
  ])('rejects "%s" (metachar %s)', (payload) => {
    const r = trycatch({ raw: payload }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.argName).toBe("raw");
      expect(r.msg).toMatch(/shell metacharacter/);
    }
  });
});

describe("hardenArgs — always-on control-char gate", () => {
  it("rejects a control character on a freeform arg (no kind / format)", () => {
    const schema: AdapterArg[] = [{ name: "anything", type: "str" }];
    const r = trycatch({ anything: "hello\u0001world" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toMatch(/control characters/);
  });

  it("rejects control chars even when format is declared", () => {
    const schema: AdapterArg[] = [{ name: "url", type: "str", format: "uri" }];
    const r = trycatch({ url: "https://\u0001example.com" }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toMatch(/control characters/);
  });
});

describe("hardenArgs — x-unicli-accepts fallback", () => {
  it('x-unicli-kind=path with accepts=["url"] allows a URL to salvage', () => {
    const schema: AdapterArg[] = [
      {
        name: "target",
        type: "str",
        "x-unicli-kind": "path",
        "x-unicli-accepts": ["url"],
      },
    ];
    // This URL is neither within CWD nor $HOME — would fail `path` — but
    // `url` fallback salvages it.
    const r = trycatch({ target: "https://example.com/resource" }, schema);
    expect(r.ok).toBe(true);
  });

  it("x-unicli-kind=path without accepts still rejects a path escaping both CWD and $HOME", () => {
    const schema: AdapterArg[] = [
      { name: "target", type: "str", "x-unicli-kind": "path" },
    ];
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    const outside = mkdtempSync(join(tmpdir(), "unicli-harden-noaccept-"));
    try {
      process.chdir(outside);
      process.env.HOME = outside;
      const r = trycatch({ target: "/etc/passwd" }, schema);
      expect(r.ok).toBe(false);
    } finally {
      process.chdir(origCwd);
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("hardenArgs — unknown field is freeform", () => {
  it("does not reject args whose name is not in the schema (pre-codemod)", () => {
    const schema: AdapterArg[] = [{ name: "known", type: "str" }];
    const r = trycatch(
      { known: "ok", random_other_field: "value-with-anything?*&" },
      schema,
    );
    expect(r.ok).toBe(true);
  });
});
