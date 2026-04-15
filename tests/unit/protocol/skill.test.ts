/**
 * Skill loader unit tests — frontmatter parsing, multi-dir discovery,
 * trigger matching, and dependency resolution.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSkills,
  parseSkillFile,
  parseFrontmatter,
  matchTrigger,
  resolveDependencies,
} from "../../../src/protocol/skill.js";

/**
 * Build a self-contained skills tree rooted in a temp dir so tests do not
 * rely on the repo's real `skills/` directory.
 */
function makeSkillsTree(root: string, skills: Record<string, string>): void {
  for (const [name, content] of Object.entries(skills)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
  }
}

const FIXTURE_FOO = `---
name: foo
description: Foo skill for testing
triggers:
  - "foo"
  - "bar"
version: 1.2.3
allowed-tools:
  - Bash
depends-on:
  - bar
---

# Foo

Body of the foo skill.
`;

const FIXTURE_BAR = `---
name: bar
description: Bar skill that foo depends on
triggers: ["bar", "baz"]
---

Body of bar.
`;

const FIXTURE_PIPELINE = `---
name: pipeline-skill
description: Skill with inline pipeline
---

Some body text.

\`\`\`yaml
pipeline:
  - set:
      greeting: hello
\`\`\`
`;

const FIXTURE_INVALID = `no frontmatter at all, just markdown`;

describe("parseFrontmatter", () => {
  it("splits frontmatter + body on the first --- pair", () => {
    const parsed = parseFrontmatter(FIXTURE_FOO);
    expect(parsed).toBeDefined();
    expect(parsed!.frontmatter.name).toBe("foo");
    expect(parsed!.body.trimStart()).toMatch(/^# Foo/);
  });

  it("returns undefined when there is no leading ---", () => {
    expect(parseFrontmatter(FIXTURE_INVALID)).toBeUndefined();
  });
});

describe("parseSkillFile", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-skill-"));
    makeSkillsTree(dir, { foo: FIXTURE_FOO });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parses required + optional frontmatter fields", () => {
    const skill = parseSkillFile(join(dir, "foo", "SKILL.md"), "repo");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("foo");
    expect(skill!.description).toBe("Foo skill for testing");
    expect(skill!.triggers).toEqual(["foo", "bar"]);
    expect(skill!.version).toBe("1.2.3");
    expect(skill!.allowedTools).toEqual(["Bash"]);
    expect(skill!.dependsOn).toEqual(["bar"]);
  });
});

describe("loadSkills — multi-dir discovery", () => {
  let repoDir: string;
  let homeDir: string;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "unicli-skills-repo-"));
    homeDir = mkdtempSync(join(tmpdir(), "unicli-skills-home-"));
    makeSkillsTree(repoDir, { foo: FIXTURE_FOO, bar: FIXTURE_BAR });
    const userSkillsRoot = join(homeDir, ".unicli", "skills");
    mkdirSync(userSkillsRoot, { recursive: true });
    makeSkillsTree(userSkillsRoot, { "pipeline-skill": FIXTURE_PIPELINE });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("discovers skills from both repo/ and $HOME/.unicli/skills", () => {
    const skills = loadSkills({
      repoDir,
      homeDir,
    });
    const names = skills.map((s) => s.name).sort();
    expect(names).toContain("foo");
    expect(names).toContain("bar");
    expect(names).toContain("pipeline-skill");
  });

  it("tags each skill with its source directory", () => {
    const skills = loadSkills({ repoDir, homeDir });
    const foo = skills.find((s) => s.name === "foo");
    const pipeline = skills.find((s) => s.name === "pipeline-skill");
    expect(foo!.source).toBe("repo");
    expect(pipeline!.source).toBe("user");
  });

  it("extracts inline pipeline from a fenced code block", () => {
    const skills = loadSkills({ repoDir, homeDir });
    const pipeline = skills.find((s) => s.name === "pipeline-skill");
    expect(pipeline).toBeDefined();
    expect(pipeline!.pipeline).toBeDefined();
    expect(pipeline!.pipeline!.length).toBe(1);
  });

  it("repo root wins on name conflict (precedence order)", () => {
    // Create a conflicting skill in the home dir
    const homeConflict = mkdtempSync(join(tmpdir(), "unicli-home2-"));
    const userSkills = join(homeConflict, ".unicli", "skills");
    mkdirSync(userSkills, { recursive: true });
    makeSkillsTree(userSkills, {
      foo: `---\nname: foo\ndescription: user override\n---\n`,
    });
    const skills = loadSkills({ repoDir, homeDir: homeConflict });
    const foo = skills.find((s) => s.name === "foo");
    expect(foo!.description).toBe("Foo skill for testing");
    rmSync(homeConflict, { recursive: true, force: true });
  });
});

describe("matchTrigger", () => {
  it("matches a query token against any trigger / name / description", () => {
    const skills = [
      {
        name: "foo",
        description: "Foo skill",
        triggers: ["check twitter", "fetch tweets"],
        dependsOn: [],
        allowedTools: [],
        body: "",
        path: "/tmp/foo",
        source: "repo" as const,
        raw: {},
      },
    ];
    expect(matchTrigger(skills, "twitter").length).toBe(1);
    expect(matchTrigger(skills, "nonexistent").length).toBe(0);
  });
});

describe("resolveDependencies", () => {
  const skills = [
    {
      name: "a",
      description: "",
      triggers: [],
      dependsOn: ["b"],
      allowedTools: [],
      body: "",
      path: "/tmp/a",
      source: "repo" as const,
      raw: {},
    },
    {
      name: "b",
      description: "",
      triggers: [],
      dependsOn: ["c"],
      allowedTools: [],
      body: "",
      path: "/tmp/b",
      source: "repo" as const,
      raw: {},
    },
    {
      name: "c",
      description: "",
      triggers: [],
      dependsOn: [],
      allowedTools: [],
      body: "",
      path: "/tmp/c",
      source: "repo" as const,
      raw: {},
    },
  ];

  it("returns dependencies in post-order (deepest first)", () => {
    const order = resolveDependencies(skills, "a");
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("handles cycles without infinite recursion", () => {
    const cyclic = [
      {
        ...skills[0],
        dependsOn: ["b"],
      },
      {
        ...skills[1],
        dependsOn: ["a"],
      },
    ];
    const order = resolveDependencies(cyclic, "a");
    expect(order.sort()).toEqual(["a", "b"]);
  });
});
