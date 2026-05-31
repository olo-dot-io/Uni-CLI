import { describe, expect, it } from "vitest";

import {
  parseSetCookiePairs,
  mergeCookieHeader,
  sameRegistrableHost,
} from "../../../src/engine/cookie-capture.js";

describe("parseSetCookiePairs", () => {
  it("extracts name=value, dropping attributes after the first semicolon", () => {
    const lines = [
      "JSESSIONID=abc123; Path=/otn; HttpOnly",
      "BIGipServerotn=987.0; path=/; Httponly",
    ];
    expect(parseSetCookiePairs(lines)).toEqual({
      JSESSIONID: "abc123",
      BIGipServerotn: "987.0",
    });
  });

  it("ignores malformed lines without an = sign", () => {
    expect(parseSetCookiePairs(["", "noequalshere", "ok=1"])).toEqual({
      ok: "1",
    });
  });

  it("keeps the last value when a cookie name repeats", () => {
    expect(parseSetCookiePairs(["a=1", "a=2"])).toEqual({ a: "2" });
  });

  it("returns an empty object for no cookies", () => {
    expect(parseSetCookiePairs([])).toEqual({});
  });
});

describe("mergeCookieHeader", () => {
  it("merges captured pairs onto an existing cookie header", () => {
    expect(mergeCookieHeader("existing=1", { JSESSIONID: "x" })).toBe(
      "existing=1; JSESSIONID=x",
    );
  });

  it("overwrites an existing cookie of the same name", () => {
    expect(mergeCookieHeader("a=old; b=2", { a: "new" })).toBe("b=2; a=new");
  });

  it("produces a header from scratch when none existed", () => {
    expect(mergeCookieHeader(undefined, { a: "1", b: "2" })).toBe("a=1; b=2");
  });

  it("returns the original header unchanged when nothing is captured", () => {
    expect(mergeCookieHeader("a=1", {})).toBe("a=1");
  });
});

describe("sameRegistrableHost", () => {
  it("accepts identical hosts", () => {
    expect(
      sameRegistrableHost(
        "https://kyfw.12306.cn/otn/leftTicket/init",
        "https://kyfw.12306.cn/otn/leftTicket/init",
      ),
    ).toBe(true);
  });

  it("accepts a subdomain of the same registrable domain", () => {
    expect(
      sameRegistrableHost("https://kyfw.12306.cn/x", "https://www.12306.cn/y"),
    ).toBe(true);
  });

  it("rejects a cross-site redirect (cookie-leak guard)", () => {
    expect(
      sameRegistrableHost(
        "https://kyfw.12306.cn/x",
        "https://evil.example.com/y",
      ),
    ).toBe(false);
  });

  it("rejects when the final URL is unparseable", () => {
    expect(sameRegistrableHost("https://kyfw.12306.cn/x", "not a url")).toBe(
      false,
    );
  });
});
