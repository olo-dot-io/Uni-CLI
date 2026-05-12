import { describe, expect, it } from "vitest";
import { mapRfcRow, requireRfcNumber, trimRfcDate } from "./rfc.js";

describe("rfc agent-facing metadata command", () => {
  it("validates RFC numbers", () => {
    expect(requireRfcNumber("rfc9000")).toBe(9000);
    expect(requireRfcNumber(791)).toBe(791);
    expect(() => requireRfcNumber("9000bis")).toThrow("not valid");
  });

  it("normalizes RFC dates", () => {
    expect(trimRfcDate("2022-02-19 08:46:51")).toBe("2022-02-19");
    expect(trimRfcDate("no date")).toBeNull();
  });

  it("maps RFC metadata rows", () => {
    expect(
      mapRfcRow(9000, {
        title: "QUIC: A UDP-Based Multiplexed and Secure Transport",
        state: "RFC",
        std_level: "Proposed Standard",
        group: { name: "QUIC", type: "wg" },
        pages: "151",
        time: "2021-05-27T00:00:00+00:00",
        authors: [{ name: "J. Iyengar" }, { name: "M. Thomson" }],
        abstract: "This document defines the core of QUIC.",
      }),
    ).toMatchObject({
      rfc: 9000,
      group: "QUIC",
      pages: 151,
      published: "2021-05-27",
      authors: "J. Iyengar, M. Thomson",
      rfcEditorUrl: "https://www.rfc-editor.org/rfc/rfc9000",
    });
  });
});
