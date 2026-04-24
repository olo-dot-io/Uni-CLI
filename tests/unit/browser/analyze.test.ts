import { describe, expect, it } from "vitest";
import {
  analyzeSite,
  classifyPattern,
  detectAntiBot,
  type PageSignals,
} from "../../../src/browser/analyze.js";
import {
  AdapterType,
  Strategy,
  type AdapterManifest,
} from "../../../src/types.js";

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    requestedUrl: "https://example.com/feed",
    finalUrl: "https://example.com/feed",
    title: "Example",
    cookieNames: [],
    networkEntries: [],
    initialState: {
      __INITIAL_STATE__: false,
      __NUXT__: false,
      __NEXT_DATA__: false,
      __APOLLO_STATE__: false,
    },
    ...overrides,
  };
}

describe("browser analyze", () => {
  it("classifies one auth-failing API response as token-gated pattern D", () => {
    const verdict = classifyPattern(
      signals({
        networkEntries: [
          {
            url: "https://example.com/api/private-feed",
            status: 403,
            contentType: "text/html",
            bodyPreview: "<html>forbidden</html>",
          },
        ],
      }),
    );

    expect(verdict.pattern).toBe("D");
    expect(verdict.auth_failures).toBe(1);
  });

  it("detects websocket traffic as pattern E instead of falling through to HTML scrape", () => {
    const verdict = classifyPattern(
      signals({
        networkEntries: [
          {
            url: "wss://example.com/socket/feed",
            status: 101,
            contentType: "websocket",
            bodyPreview: null,
          },
        ],
      }),
    );

    expect(verdict.pattern).toBe("E");
  });

  it("keeps evidence from multiple anti-bot vendors while choosing the strongest vendor", () => {
    const verdict = detectAntiBot(
      signals({
        cookieNames: ["__cf_bm", "acw_tc"],
        networkEntries: [
          {
            url: "https://example.com/",
            status: 200,
            contentType: "text/html",
            bodyPreview: "Cloudflare Ray ID and /ntc_captcha/",
          },
        ],
      }),
    );

    expect(verdict.detected).toBe(true);
    expect(verdict.vendor).toBe("cloudflare");
    expect(verdict.evidence).toEqual(
      expect.arrayContaining(["cookie:__cf_bm", "cookie:acw_tc"]),
    );
  });

  it("reports nearest existing adapter from Uni-CLI manifests", () => {
    const adapters: AdapterManifest[] = [
      {
        name: "example",
        type: AdapterType.WEB_API,
        domain: "example.com",
        strategy: Strategy.PUBLIC,
        commands: {
          search: { name: "search", columns: ["title"] },
          feed: { name: "feed", columns: ["title"] },
        },
      },
    ];

    const report = analyzeSite(
      signals({
        networkEntries: [
          {
            url: "https://example.com/api/feed",
            status: 200,
            contentType: "application/json",
            bodyPreview: '{"items":[]}',
          },
        ],
      }),
      adapters,
    );

    expect(report.nearest_adapter).toMatchObject({
      site: "example",
      example_commands: ["example feed", "example search"],
    });
    expect(report.recommended_next_step).toContain("browser network");
  });
});
