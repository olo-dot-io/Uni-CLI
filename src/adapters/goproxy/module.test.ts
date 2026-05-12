import { describe, expect, it } from "vitest";
import {
  mapGoProxyModuleRow,
  mapGoProxyVersionRows,
  requireGoModulePath,
  requireGoProxyLimit,
  sortGoVersionsDescending,
} from "./module.js";

describe("goproxy agent-facing commands", () => {
  it("validates module paths and limits", () => {
    expect(requireGoModulePath("github.com/gin-gonic/gin")).toBe(
      "github.com/gin-gonic/gin",
    );
    expect(() => requireGoModulePath("")).toThrow("module path is required");
    expect(() => requireGoModulePath("noslash")).toThrow("not recognised");
    expect(requireGoProxyLimit(undefined)).toBe(30);
    expect(requireGoProxyLimit("200")).toBe(200);
    expect(() => requireGoProxyLimit("0")).toThrow("goproxy limit must");
  });

  it("sorts Go semver tags descending", () => {
    expect(
      sortGoVersionsDescending(["bad", "v1.2.0-beta.1", "v1.10.0", "v1.2.0"]),
    ).toEqual(["v1.10.0", "v1.2.0", "v1.2.0-beta.1"]);
  });

  it("maps module metadata rows", () => {
    expect(
      mapGoProxyModuleRow("github.com/gin-gonic/gin", {
        Version: "v1.10.0",
        Time: "2026-05-01T12:00:00.123Z",
        Origin: {
          VCS: "git",
          URL: "https://github.com/gin-gonic/gin",
          Hash: "abc",
          Ref: "refs/tags/v1.10.0",
        },
      }),
    ).toEqual({
      module: "github.com/gin-gonic/gin",
      version: "v1.10.0",
      publishedAt: "2026-05-01T12:00:00Z",
      vcs: "git",
      repository: "https://github.com/gin-gonic/gin",
      commit: "abc",
      ref: "refs/tags/v1.10.0",
      pkgGoDevUrl: "https://pkg.go.dev/github.com/gin-gonic/gin",
      url: "https://proxy.golang.org/github.com/gin-gonic/gin/@latest",
    });
    expect(() => mapGoProxyModuleRow("github.com/x/y", {})).toThrow(
      "returned no @latest entry",
    );
  });

  it("maps version rows without sentinel output", () => {
    expect(
      mapGoProxyVersionRows("github.com/gin-gonic/gin", ["v1.0.0", "bad"], 10),
    ).toEqual([
      {
        rank: 1,
        module: "github.com/gin-gonic/gin",
        version: "v1.0.0",
        publishedAt: null,
        url: "https://proxy.golang.org/github.com/gin-gonic/gin/@v/v1.0.0.info",
      },
    ]);
    expect(() => mapGoProxyVersionRows("github.com/x/y", ["bad"], 10)).toThrow(
      "no semver-shaped tags",
    );
  });
});
