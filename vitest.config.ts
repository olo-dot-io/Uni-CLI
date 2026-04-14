import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/setup.ts",
    // CI runners are 3–4× slower than dev machines. Tests that spawn child
    // processes (e.g. MCP server stdio integration) routinely land 8–12 s
    // in CI, brushing against the 10 s default and causing flaky failures
    // on Dependabot PRs despite identical code. 30 s leaves headroom.
    hookTimeout: 30_000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "adapter",
          include: ["tests/adapter/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
