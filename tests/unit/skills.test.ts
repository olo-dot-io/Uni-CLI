/**
 * Skills export — frontmatter compliance with Anthropic SKILL.md spec.
 *
 * The spec requires `name` (kebab-case) and `description` (one line) at
 * minimum. We additionally emit `when_to_use`, `command`, and `source` so
 * downstream tools can filter by intent + provenance.
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  buildSkillForCommand,
  renderSkillMarkdown,
  buildCatalog,
} from "../../src/commands/skills.js";
import { registerAdapter, getAllAdapters } from "../../src/registry.js";
import { AdapterType, Strategy } from "../../src/types.js";
import type { AdapterManifest } from "../../src/types.js";

function makeFixtureAdapter(): AdapterManifest {
  return {
    name: "fixture-site",
    type: AdapterType.WEB_API,
    description: "Fixture adapter for tests",
    domain: "example.com",
    strategy: Strategy.PUBLIC,
    commands: {
      top: {
        name: "top",
        description: "Top items right now",
        columns: ["rank", "title", "score"],
        adapterArgs: [
          { name: "limit", type: "int", default: 20, positional: false },
        ],
      },
      search: {
        name: "search",
        description: "Search for items",
        columns: ["title", "url"],
        adapterArgs: [
          {
            name: "query",
            type: "str",
            required: true,
            positional: true,
            description: "Search query",
          },
          {
            name: "limit",
            type: "int",
            default: 20,
            positional: false,
          },
        ],
      },
    },
  };
}

describe("buildSkillForCommand", () => {
  const adapter = makeFixtureAdapter();

  it("generates a kebab-case skill name <site>-<command>", () => {
    const skill = buildSkillForCommand(adapter, "top", adapter.commands.top!);
    expect(skill.name).toBe("fixture-site-top");
  });

  it("uses the command description as the description field", () => {
    const skill = buildSkillForCommand(adapter, "top", adapter.commands.top!);
    expect(skill.description).toBe("Top items right now");
  });

  it("falls back to adapter description when command description missing", () => {
    const noDescAdapter: AdapterManifest = {
      ...adapter,
      commands: {
        bare: { name: "bare" },
      },
    };
    const skill = buildSkillForCommand(noDescAdapter, "bare", { name: "bare" });
    expect(skill.description).toBe("Fixture adapter for tests");
  });

  it("infers when_to_use from common verbs", () => {
    const top = buildSkillForCommand(adapter, "top", adapter.commands.top!);
    expect(top.whenToUse).toMatch(/top/);
    const search = buildSkillForCommand(
      adapter,
      "search",
      adapter.commands.search!,
    );
    expect(search.whenToUse).toMatch(/search/i);
  });

  it("includes the executable command line", () => {
    const skill = buildSkillForCommand(adapter, "top", adapter.commands.top!);
    expect(skill.command).toBe("unicli fixture-site top");
  });
});

describe("renderSkillMarkdown — frontmatter parses as valid YAML", () => {
  it("emits a valid YAML frontmatter block", () => {
    const adapter = makeFixtureAdapter();
    const skill = buildSkillForCommand(adapter, "top", adapter.commands.top!);
    const md = renderSkillMarkdown(skill);

    // Frontmatter is between the first two `---` lines.
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    const fm = yaml.load(fmMatch![1]) as Record<string, string>;
    expect(fm.name).toBe("fixture-site-top");
    expect(fm.description).toBe("Top items right now");
    expect(fm.command).toBe("unicli fixture-site top");
    expect(fm.source).toMatch(/^unicli@/);
  });

  it("escapes descriptions that contain reserved YAML chars", () => {
    const skill = buildSkillForCommand(makeFixtureAdapter(), "weird", {
      name: "weird",
      description: "Has: colon and # hash and [brackets]",
    });
    const md = renderSkillMarkdown(skill);
    const fm = yaml.load(md.match(/^---\n([\s\S]*?)\n---\n/)![1]) as Record<
      string,
      string
    >;
    expect(fm.description).toBe("Has: colon and # hash and [brackets]");
  });

  it("body documents how to call it", () => {
    const adapter = makeFixtureAdapter();
    const skill = buildSkillForCommand(
      adapter,
      "search",
      adapter.commands.search!,
    );
    const md = renderSkillMarkdown(skill);
    expect(md).toContain("## What it does");
    expect(md).toContain("## How to call it");
    expect(md).toContain("unicli fixture-site search <query>");
  });
});

describe("buildCatalog — machine-readable single source of truth", () => {
  it("produces a JSON-serializable catalog with totals + adapters", () => {
    // Ensure at least one adapter is registered for the run.
    registerAdapter(makeFixtureAdapter());
    const catalog = buildCatalog();
    expect(catalog.source).toMatch(/^unicli@/);
    expect(catalog.generated).toMatch(/T/);
    expect(catalog.total_sites).toBeGreaterThanOrEqual(1);
    expect(catalog.total_commands).toBeGreaterThanOrEqual(2);
    const fixture = catalog.adapters.find((a) => a.site === "fixture-site");
    expect(fixture).toBeDefined();
    expect(fixture!.commands.length).toBe(2);
    expect(fixture!.commands[0].command).toMatch(/^unicli fixture-site /);
    // Round-trips through JSON without error
    expect(() => JSON.stringify(catalog)).not.toThrow();
  });
});

describe("auth note in body when adapter requires auth", () => {
  it("renders auth setup hint for non-public strategy", () => {
    const cookieAdapter: AdapterManifest = {
      name: "private-site",
      type: AdapterType.WEB_API,
      strategy: Strategy.COOKIE,
      commands: {
        feed: {
          name: "feed",
          description: "Auth-only feed",
        },
      },
    };
    const skill = buildSkillForCommand(
      cookieAdapter,
      "feed",
      cookieAdapter.commands.feed!,
    );
    const md = renderSkillMarkdown(skill);
    expect(md).toContain("Auth required");
    expect(md).toContain("unicli auth setup private-site");
  });
});

describe("registry sanity — at least the loader-discovered adapters are registered", () => {
  it("getAllAdapters returns a non-empty list once tests register fixtures", () => {
    expect(getAllAdapters().length).toBeGreaterThanOrEqual(1);
  });
});
