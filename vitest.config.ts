import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/setup.ts",
    // CI runners are 3–4× slower than dev machines. Tests that spawn child
    // processes (e.g. MCP server stdio integration) routinely land 8–12 s
    // in CI, brushing against the 10 s default and causing flaky failures
    // on Dependabot PRs despite identical code. 30 s leaves headroom.
    hookTimeout: 30_000,
    // Localhost fetches are legal inside the test harness — the test owns
    // the server it's about to hit. Production code never has this env var
    // set, so the SSRF guard stays active by default everywhere else.
    env: {
      UNICLI_ALLOW_LOCAL: "1",
    },
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
