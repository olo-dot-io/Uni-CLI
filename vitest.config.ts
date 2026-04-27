import { defineConfig } from "vitest/config";

const workerEnv = {
  UNICLI_ALLOW_LOCAL: "1",
};

const workerSetup = "./tests/setup-env.ts";

export default defineConfig({
  test: {
    globalSetup: "./tests/setup.ts",
    setupFiles: workerSetup,
    // CI runners are 3–4× slower than dev machines. Tests that spawn child
    // processes (e.g. MCP server stdio integration) routinely land 8–12 s
    // in CI, brushing against the 10 s default and causing flaky failures
    // on Dependabot PRs despite identical code. 30 s leaves headroom.
    hookTimeout: 30_000,
    // Several unit suites spawn `node dist/main.js` and `npx tsx` child
    // processes. Letting Vitest fan out across every core can make those
    // subprocesses compete hard enough to hit their own 30s timeout even
    // though the product path is healthy.
    maxWorkers: 2,
    // Localhost fetches are legal inside the test harness — the test owns
    // the server it's about to hit. Production code never has this env var
    // set, so the SSRF guard stays active by default everywhere else.
    env: {
      ...workerEnv,
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: workerSetup,
          env: {
            ...workerEnv,
          },
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: workerSetup,
          env: {
            ...workerEnv,
          },
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "adapter",
          include: ["tests/adapter/**/*.test.ts", "src/adapters/**/*.test.ts"],
          setupFiles: workerSetup,
          env: {
            ...workerEnv,
          },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
