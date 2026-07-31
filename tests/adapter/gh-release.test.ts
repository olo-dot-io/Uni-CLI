import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { evalTemplate } from "../../src/engine/template.js";

type ReleaseAdapter = {
  pipeline: Array<{
    exec?: { args?: unknown[] };
    map?: Record<string, string>;
  }>;
};

describe("gh release adapter", () => {
  it("uses fields supported by gh release list and preserves the public URL", () => {
    const adapter = yaml.load(
      readFileSync(join(process.cwd(), "src/adapters/gh/release.yaml"), "utf8"),
    ) as ReleaseAdapter;
    const execArgs = adapter.pipeline.find((step) => step.exec)?.exec?.args;
    expect(execArgs).toContain("tagName,name,publishedAt,isPrerelease");
    expect(execArgs).not.toContain("tagName,name,publishedAt,isPrerelease,url");

    const urlTemplate = adapter.pipeline.find((step) => step.map)?.map?.url;
    expect(urlTemplate).toBeDefined();
    expect(
      evalTemplate(urlTemplate!, {
        data: { tagName: "v1.8.6" },
        args: { repo: "jackwener/OpenCLI" },
        vars: {},
        canMutate: false,
      }),
    ).toBe("https://github.com/jackwener/OpenCLI/releases/tag/v1.8.6");
  });
});
