/**
 * @owner tests/unit/docs-home-operation.test.ts
 * @does Keep the public first-route example aligned with its owned adapter contract.
 * @needs docs/home-operation.json, src/adapters/hackernews, dist/manifest.json
 * @feeds README and Pages truth gate
 * @breaks The landing page can present a fictional operator, strategy, or candidate.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import operation from "../../docs/home-operation.json";
import manifest from "../../dist/manifest.json";

const topAdapter = parse(
  readFileSync("src/adapters/hackernews/top.yaml", "utf-8"),
) as Record<string, unknown>;
const hackerNewsCommands = new Set(
  manifest.sites.hackernews.commands.map((command) => command.name),
);

describe("public home operation", () => {
  it("uses the real public structured Hacker News contract", () => {
    expect(operation.selected).toEqual({
      operation: "hackernews.top",
      operator: "structured-api",
      effect: "read",
      strategy: "public",
    });
    expect(topAdapter).toMatchObject({
      site: "hackernews",
      name: "top",
      type: "web-api",
      strategy: "public",
      operation_effect: "read",
      browser: false,
    });
    expect(operation.shell).toBe("unicli hackernews top --limit 3 -f json");
  });

  it("keeps both README first routes aligned with the shared example", () => {
    const readme = readFileSync("README.md", "utf-8");
    const readmeZh = readFileSync("README.zh-CN.md", "utf-8");

    expect(readme.toLowerCase()).toContain(operation.intent.en.toLowerCase());
    expect(readme).toContain(operation.shell);
    expect(readmeZh).toContain(operation.intent.zh);
    expect(readmeZh).toContain(operation.shell);
  });

  it.each([[operation.candidates.en], [operation.candidates.zh]])(
    "keeps each ranked candidate in the live manifest",
    (candidates) => {
      for (const candidate of candidates) {
        expect(candidate.startsWith("hackernews.")).toBe(true);
        expect(hackerNewsCommands.has(candidate.split(".")[1])).toBe(true);
      }
    },
  );
});
