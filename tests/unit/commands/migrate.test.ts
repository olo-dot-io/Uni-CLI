/**
 * Tests for the legacy YAML -> Uni-CLI YAML migration.
 *
 * Each fixture represents a common legacy adapter shape. We round-trip
 * it through `migrateLegacyYaml` and assert:
 *  1. Known fields are mapped to Uni-CLI v2 equivalents.
 *  2. Unknown fields are preserved under `_legacy_extra`.
 *  3. Pipeline step renames are reported in the warnings.
 *  4. Schema-v2 metadata (transport, capabilities, trust, etc.) is filled in.
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  migrateLegacyYaml,
  emitUnicliYaml,
} from "../../../src/commands/migrate.js";

function parseFixture(src: string): Record<string, unknown> {
  const parsed = yaml.load(src);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fixture not an object");
  }
  return parsed as Record<string, unknown>;
}

describe("migrate legacy-yaml", () => {
  it("search-style adapter: maps auth -> strategy and renames extract -> map", () => {
    const fixture = parseFixture(`
site: hackernews
name: search
summary: Search HN via algolia
type: web-api
auth: none
arguments:
  - { name: q, required: true }
steps:
  - http:
      url: "https://hn.algolia.com/api/v1/search?query={{ q }}"
  - jsonpath: "hits"
  - extract:
      title: "{{ item.title }}"
      url: "{{ item.url }}"
  - slice: 20
output_columns: [title, url]
`);
    const report = migrateLegacyYaml(fixture);
    const out = report.output;

    expect(out.site).toBe("hackernews");
    expect(out.name).toBe("search");
    expect(out.description).toBe("Search HN via algolia");
    expect(out.type).toBe("web-api");
    expect(out.strategy).toBe("public");
    expect(out.transport).toBe("http");
    expect(out.trust).toBe("public");
    expect(out.confidentiality).toBe("public");
    expect(out.quarantine).toBe(false);
    expect(out.minimum_capability).toBe("http.fetch");

    expect(out.pipeline).toBeDefined();
    const pipe = out.pipeline as Array<Record<string, unknown>>;
    expect(Object.keys(pipe[0])).toContain("fetch");
    expect(Object.keys(pipe[1])).toContain("select");
    expect(Object.keys(pipe[2])).toContain("map");
    expect(Object.keys(pipe[3])).toContain("limit");

    expect(report.renamed_steps).toEqual(
      expect.arrayContaining([
        "http -> fetch",
        "jsonpath -> select",
        "extract -> map",
        "slice -> limit",
      ]),
    );

    expect(out.capabilities).toEqual(
      expect.arrayContaining(["fetch", "select", "map", "limit"]),
    );
    expect(out.columns).toEqual(["title", "url"]);
  });

  it("download-style adapter: cookie auth -> strategy + http transport + internal confidentiality", () => {
    const fixture = parseFixture(`
site: bilibili
name: download
description: Download video by bv id
type: desktop
authentication: cookies
parameters:
  - { name: bvid, required: true, positional: true }
steps:
  - run:
      command: yt-dlp
      args: ["https://bilibili.com/video/{{ bvid }}"]
      timeout: 300000
unknown_legacy_field: "preserved"
throttle:
  per_domain: 2
  burst: 5
`);
    const report = migrateLegacyYaml(fixture);
    const out = report.output;

    expect(out.site).toBe("bilibili");
    expect(out.strategy).toBe("cookie");
    expect(out.transport).toBe("http"); // cookie -> http
    expect(out.confidentiality).toBe("internal"); // non-public auth
    expect(out.trust).toBe("public");

    const pipe = out.pipeline as Array<Record<string, unknown>>;
    expect(Object.keys(pipe[0])).toContain("exec"); // run -> exec
    expect(report.renamed_steps).toContain("run -> exec");

    expect(out.rate_limit).toEqual({ per_domain: 2, burst: 5 });

    expect(report.dropped_fields).toContain("unknown_legacy_field");
    expect(out._legacy_extra).toEqual({
      unknown_legacy_field: "preserved",
    });
    expect(
      report.warnings.some((w) => w.includes("unknown_legacy_field")),
    ).toBe(true);
  });

  it("fetch-intercept adapter: xhr auth -> intercept -> cdp-browser transport", () => {
    const fixture = parseFixture(`
site: twitter
name: timeline
summary: Home timeline via intercept
type: browser
auth: xhr
steps:
  - open:
      url: "https://twitter.com/home"
  - watch:
      pattern: "/graphql/.*/HomeTimeline"
      wait: 8000
  - jsonpath: "data.home.home_timeline_urt.instructions[0].entries"
  - drop: "{{ item.entryId not startsWith 'tweet-' }}"
  - take: 20
`);
    const report = migrateLegacyYaml(fixture);
    const out = report.output;

    expect(out.strategy).toBe("intercept");
    expect(out.transport).toBe("cdp-browser");
    expect(out.minimum_capability).toBe("cdp-browser.intercept");
    expect(out.confidentiality).toBe("internal");

    const pipe = out.pipeline as Array<Record<string, unknown>>;
    expect(Object.keys(pipe[0])).toContain("navigate"); // open -> navigate
    expect(Object.keys(pipe[1])).toContain("intercept"); // watch -> intercept
    expect(Object.keys(pipe[2])).toContain("select");
    expect(Object.keys(pipe[3])).toContain("filter"); // drop -> filter
    expect(Object.keys(pipe[4])).toContain("limit"); // take -> limit

    expect(out.capabilities).toEqual(
      expect.arrayContaining([
        "navigate",
        "intercept",
        "select",
        "filter",
        "limit",
      ]),
    );
  });

  it("emitUnicliYaml produces stable, ordered output", () => {
    const fixture = parseFixture(`
site: example
name: top
auth: none
steps:
  - http: { url: "https://example.com/api" }
  - extract: { id: "{{ item.id }}" }
`);
    const report = migrateLegacyYaml(fixture);
    const first = emitUnicliYaml(report.output);
    const second = emitUnicliYaml(report.output);
    expect(first).toBe(second);

    // Key order sanity: site comes before pipeline.
    const siteIdx = first.indexOf("\nsite:");
    const pipelineIdx = first.indexOf("\npipeline:");
    // site is at top of file so siteIdx may be 0 (no leading \n). Use the
    // combined search:
    const siteAt = first.startsWith("site:") ? 0 : siteIdx;
    expect(siteAt).toBeLessThan(pipelineIdx);
  });
});
