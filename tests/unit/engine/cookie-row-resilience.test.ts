import { describe, expect, it } from "vitest";

import {
  decodeCookieRows,
  type RawCookieRow,
} from "../../../src/engine/chromium-cookies.js";
import { ChromiumCookieError } from "../../../src/engine/chromium-cookies-types.js";

function row(over: Partial<RawCookieRow>): RawCookieRow {
  return {
    host: "x.com",
    name: "n",
    encrypted: Buffer.from("ENC"),
    plain: "",
    path: "/",
    expires: 0,
    isSecure: 1,
    isHttpOnly: 1,
    isPersistent: 1,
    hasExpires: 1,
    ...over,
  };
}

describe("decodeCookieRows — per-row decrypt resilience (v20 regression)", () => {
  it("returns all rows when every decrypt succeeds", () => {
    const out = decodeCookieRows(
      [row({ name: "a" }), row({ name: "b" })],
      () => "OK",
    );
    expect(out.map((r) => [r.name, r.value])).toEqual([
      ["a", "OK"],
      ["b", "OK"],
    ]);
  });

  it("uses the plain value for an unencrypted row without calling decrypt", () => {
    const out = decodeCookieRows(
      [row({ name: "p", encrypted: Buffer.alloc(0), plain: "raw" })],
      () => {
        throw new Error("decrypt must not be called for a plain row");
      },
    );
    expect(out[0]?.value).toBe("raw");
  });

  it("SKIPS one undecryptable (v20) row but keeps the decryptable ones", () => {
    const rows = [
      row({ name: "good1" }),
      row({ name: "v20" }),
      row({ name: "good2" }),
    ];
    const out = decodeCookieRows(rows, (enc) => {
      const r = rows.find((x) => x.encrypted === enc);
      if (r?.name === "v20")
        throw new ChromiumCookieError("encryption_unsupported", "v20 ABE");
      return "OK";
    });
    expect(out.map((r) => r.name)).toEqual(["good1", "good2"]);
  });

  it("THROWS a typed error (not silent empty) when every encrypted row fails", () => {
    expect(() =>
      decodeCookieRows([row({ name: "a" }), row({ name: "b" })], () => {
        throw new ChromiumCookieError("encryption_unsupported", "v20 ABE");
      }),
    ).toThrow(ChromiumCookieError);
  });

  it("does NOT throw on empty input", () => {
    expect(decodeCookieRows([], () => "OK")).toEqual([]);
  });

  it("returns surviving plain rows without throwing even if all encrypted rows fail", () => {
    const out = decodeCookieRows(
      [
        row({ name: "enc", encrypted: Buffer.from("ENC") }),
        row({ name: "plain", encrypted: Buffer.alloc(0), plain: "v" }),
      ],
      () => {
        throw new ChromiumCookieError("decrypt_failed", "bad");
      },
    );
    expect(out.map((r) => [r.name, r.value])).toEqual([["plain", "v"]]);
  });

  it("maps cookie metadata numeric flags to booleans", () => {
    const out = decodeCookieRows(
      [
        row({
          name: "a",
          isSecure: 1,
          isHttpOnly: 0,
          isPersistent: 0,
          hasExpires: 0,
        }),
      ],
      () => "OK",
    );
    expect(out[0]).toMatchObject({
      secure: true,
      httpOnly: false,
      persistent: false,
      hasExpires: false,
    });
  });
});
