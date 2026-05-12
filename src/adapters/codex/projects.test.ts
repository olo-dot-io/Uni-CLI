import { describe, expect, it } from "vitest";
import { flattenCodexProjectRows, parseCodexProjectLimit } from "./projects.js";

describe("codex agent-facing projects command", () => {
  const projects = [
    {
      project: "Uni-CLI",
      projectPath: "/Users/me/Developer/Uni-CLI",
      collapsed: false,
      conversations: [
        {
          index: 1,
          title: "surface coverage",
          updated: "2h ago",
          active: true,
          threadId: "thread-1",
        },
        {
          index: 2,
          title: "Adapter repair",
          updated: "1d ago",
          active: false,
          threadId: "thread-2",
        },
      ],
    },
    {
      project: "Empty",
      projectPath: "/Users/me/Empty",
      collapsed: true,
      conversations: [],
    },
  ];

  it("validates optional positive limits", () => {
    expect(parseCodexProjectLimit(undefined)).toBeNull();
    expect(parseCodexProjectLimit("2")).toBe(2);
    expect(() => parseCodexProjectLimit("0")).toThrow("positive integer");
    expect(() => parseCodexProjectLimit("abc")).toThrow("positive integer");
  });

  it("flattens project conversations using stable columns", () => {
    expect(
      flattenCodexProjectRows(projects, { project: "uni-cli", limit: 1 }),
    ).toEqual([
      {
        Project: "Uni-CLI",
        Index: 1,
        Title: "surface coverage",
        Updated: "2h ago",
        Active: "yes",
        ProjectPath: "/Users/me/Developer/Uni-CLI",
        ThreadId: "thread-1",
      },
    ]);
  });

  it("emits collapsed project rows when no conversations are visible", () => {
    expect(flattenCodexProjectRows(projects, { project: "empty" })).toEqual([
      {
        Project: "Empty",
        Index: 0,
        Title: "(collapsed)",
        Updated: "",
        Active: "",
        ProjectPath: "/Users/me/Empty",
        ThreadId: "",
      },
    ]);
  });

  it("matches project path suffixes", () => {
    expect(
      flattenCodexProjectRows(projects, { project: "Developer/Uni-CLI" }),
    ).toHaveLength(2);
  });
});
