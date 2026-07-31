import { afterEach, describe, expect, it } from "vitest";
import { resolveCdpPort } from "../../../src/browser/cdp-client.js";

describe("resolveCdpPort — one consistent semantic for every caller", () => {
  const prev = process.env.UNICLI_CDP_PORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.UNICLI_CDP_PORT;
    else process.env.UNICLI_CDP_PORT = prev;
  });

  it("an explicit port wins over the environment", () => {
    process.env.UNICLI_CDP_PORT = "3000";
    expect(resolveCdpPort(4567)).toBe(4567);
  });

  it("uses a valid environment port", () => {
    process.env.UNICLI_CDP_PORT = "9333";
    expect(resolveCdpPort()).toBe(9333);
  });

  it("defaults to 9222 when no environment port is set", () => {
    delete process.env.UNICLI_CDP_PORT;
    expect(resolveCdpPort()).toBe(9222);
  });

  it("THROWS on a malformed port instead of silently falling back", () => {
    process.env.UNICLI_CDP_PORT = "not-a-port";
    expect(() => resolveCdpPort()).toThrow(/Invalid UNICLI_CDP_PORT/);
  });

  it("THROWS on an out-of-range port", () => {
    process.env.UNICLI_CDP_PORT = "70000";
    expect(() => resolveCdpPort()).toThrow(/Invalid UNICLI_CDP_PORT/);
  });
});
