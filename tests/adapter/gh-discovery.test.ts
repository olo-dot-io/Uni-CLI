import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { runPipeline } from "../../src/engine/executor.js";
import type { PipelineStep } from "../../src/types.js";

type AdapterFile = {
  name: string;
  args?: Record<string, { default?: unknown }>;
  pipeline: PipelineStep[];
};

const temporaryRoots: string[] = [];

function loadAdapter(name: string): AdapterFile {
  return yaml.load(
    readFileSync(
      join(process.cwd(), "src", "adapters", "gh", `${name}.yaml`),
      "utf8",
    ),
  ) as AdapterFile;
}

function resolvedArgs(
  adapter: AdapterFile,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(adapter.args ?? {})
        .filter(([, arg]) => arg.default !== undefined)
        .map(([name, arg]) => [name, arg.default]),
    ),
    ...overrides,
  };
}

async function runWithFakeGh(
  adapter: AdapterFile,
  args: Record<string, unknown>,
  response: unknown,
): Promise<{ result: unknown[]; invocation: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "unicli-gh-adapter-"));
  temporaryRoots.push(root);
  const binary = join(root, "gh");
  const output = join(root, "response.json");
  const log = join(root, "args.log");

  // REASON: gh is the external subprocess boundary; the real YAML pipeline,
  // template evaluation, branching, JSON parsing, selection, and mapping run.
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_FAKE_LOG"\ncat "$GH_FAKE_OUTPUT"\n',
  );
  chmodSync(binary, 0o755);
  writeFileSync(output, JSON.stringify(response));

  const originalPath = process.env.PATH;
  const originalLog = process.env.GH_FAKE_LOG;
  const originalOutput = process.env.GH_FAKE_OUTPUT;
  process.env.PATH = `${root}:${originalPath ?? ""}`;
  process.env.GH_FAKE_LOG = log;
  process.env.GH_FAKE_OUTPUT = output;
  try {
    const result = await runPipeline(
      adapter.pipeline,
      { args, source: "internal" },
      undefined,
      {
        site: "gh",
        command: adapter.name,
        strategy: "public",
        canMutate: false,
      },
    );
    return {
      result,
      invocation: readFileSync(log, "utf8").trimEnd().split("\n"),
    };
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.GH_FAKE_LOG;
    else process.env.GH_FAKE_LOG = originalLog;
    if (originalOutput === undefined) delete process.env.GH_FAKE_OUTPUT;
    else process.env.GH_FAKE_OUTPUT = originalOutput;
  }
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("gh discovery adapters", () => {
  it("keeps fuzzy repository search on best-match and composes stack filters", async () => {
    const adapter = loadAdapter("search-repos");
    const { result, invocation } = await runWithFakeGh(
      adapter,
      resolvedArgs(adapter, {
        query: "terminal UI",
        language: "Go",
        topic: "tui",
        match: "readme",
        "min-stars": 100,
        limit: 2,
      }),
      {
        total_count: 1,
        incomplete_results: false,
        items: [
          {
            id: 1,
            full_name: "rivo/tview",
            owner: { login: "rivo" },
            description: "Terminal UI library",
            topics: ["tui", "golang"],
            language: "Go",
            stargazers_count: 1000,
            forks_count: 50,
            open_issues_count: 3,
            license: { spdx_id: "MIT" },
            archived: false,
            fork: false,
            created_at: "2020-01-01T00:00:00Z",
            updated_at: "2026-08-01T00:00:00Z",
            pushed_at: "2026-08-01T00:00:00Z",
            score: 1,
            text_matches: [],
            html_url: "https://github.com/rivo/tview",
          },
        ],
      },
    );

    expect(invocation).not.toContain("sort=best-match");
    expect(invocation).not.toContain("sort");
    expect(invocation).toContain(
      "q=terminal UI in:readme language:Go topic:tui stars:>=100 is:public",
    );
    expect(result).toEqual([
      expect.objectContaining({
        fullName: "rivo/tview",
        language: "Go",
        topics: '["tui","golang"]',
        totalCount: "1",
      }),
    ]);
  });

  it("uses GitHub hybrid issue search and exposes the effective mode", async () => {
    const adapter = loadAdapter("search-issues");
    const { result, invocation } = await runWithFakeGh(
      adapter,
      resolvedArgs(adapter, {
        query: "terminal rendering glitch",
        repo: "owner/project",
        limit: 2,
      }),
      {
        total_count: 1,
        incomplete_results: false,
        search_type: "hybrid",
        items: [
          {
            id: 7,
            number: 9,
            title: "Terminal redraw leaves artifacts",
            state: "open",
            user: { login: "alice" },
            repository_url: "https://api.github.com/repos/owner/project",
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-02T00:00:00Z",
            comments: 4,
            labels: [],
            locked: false,
            score: 1,
            body: "Rendering details",
            html_url: "https://github.com/owner/project/issues/9",
          },
        ],
      },
    );

    expect(invocation).toContain("search_type=hybrid");
    expect(invocation).toContain("Accept: application/vnd.github+json");
    expect(invocation).toContain(
      "q=terminal rendering glitch is:issue is:public repo:owner/project",
    );
    expect(result).toEqual([
      expect.objectContaining({
        repository: "owner/project",
        number: "9",
        searchMode: "hybrid",
        totalCount: "1",
      }),
    ]);
  });

  it("keeps lexical issue search available for qualifier-heavy queries", async () => {
    const adapter = loadAdapter("search-issues");
    const { result, invocation } = await runWithFakeGh(
      adapter,
      resolvedArgs(adapter, {
        query: "auth error",
        repo: "owner/project",
        mode: "lexical",
        limit: 1,
      }),
      [
        {
          number: 12,
          title: "Authentication error",
          state: "open",
          author: { login: "bob" },
          repository: { nameWithOwner: "owner/project" },
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
          commentsCount: 2,
          labels: [],
          isLocked: false,
          body: "Details",
          url: "https://github.com/owner/project/issues/12",
        },
      ],
    );

    expect(invocation.slice(0, 3)).toEqual(["search", "issues", "auth error"]);
    expect(invocation).toContain("--repo=owner/project");
    expect(invocation).not.toContain("search_type=hybrid");
    expect(result).toEqual([
      expect.objectContaining({
        repository: "owner/project",
        number: "12",
        searchMode: "lexical",
      }),
    ]);
  });
});
