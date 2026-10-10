import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log(
    JSON.stringify({
      scenarios: 0,
      skipped: "Dynamic inventory requires macOS Shortcuts and SQLite",
    }),
  );
} else {
  const restart = process.argv.includes("--restart");
  const home = restart
    ? process.env.HOME!
    : mkdtempSync(join(tmpdir(), "unicli-discovery-"));
  const previousHome = process.env.HOME;
  const previousFlag = process.env.UNICLI_DYNAMIC_MACOS;
  const previousLogging = process.env.UNICLI_NO_LOG;
  const outcomes: Array<{ scenario: string; passed: boolean }> = [];
  try {
    process.env.HOME = home;
    process.env.UNICLI_DYNAMIC_MACOS = "1";
    process.env.UNICLI_NO_LOG = "1";
    const { invalidateCache, search, searchDocuments } =
      await import("../../src/discovery/search.js");
    const { invalidateMacosDynamicCache, registerMacosDynamicCommands } =
      await import("../../src/discovery/macos-dynamic.js");
    const { primeKernelCache } = await import("../../src/discovery/loader.js");
    const { getCompiled } = await import("../../src/engine/kernel/compile.js");
    const { buildInvocation, execute } =
      await import("../../src/engine/kernel/execute.js");
    const { getRegistryVersion, registerAdapter, resolveCommand } =
      await import("../../src/registry.js");
    const { AdapterType } = await import("../../src/types.js");
    const { manifestSearchDocuments } =
      await import("../../src/fast-path/handlers/discovery.js");
    const command = (name: string) => `app-action-discovery-fixture-${name}`;
    const queries = {
      alpha: "cataloglifecyclestart",
      beta: "cataloglifecyclerefreshed",
      edited: "cataloglifecycleedited",
    };

    async function inspect(query: string, name: string, description: string) {
      const found = search(query, 8).find(
        (result) => result.command === command(name),
      );
      if (!found) return false;
      const invocation = buildInvocation(
        "mcp",
        found.site,
        found.command,
        { args: {}, source: "mcp" },
        { permissionProfile: "locked", approved: true },
      );
      if (!invocation) return false;
      const result = await execute(invocation);
      return (
        result.exitCode === 0 &&
        result.results.some(
          (row) =>
            row.name === name[0].toUpperCase() + name.slice(1) &&
            row.description === description &&
            row.executable === false,
        )
      );
    }

    if (restart) {
      registerMacosDynamicCommands();
      primeKernelCache();
      outcomes.push({
        scenario: "Restart reads and executes the persisted inventory",
        passed: await inspect(queries.edited, "beta", queries.edited),
      });
    } else {
      const toolkit = join(home, "Library", "Shortcuts", "ToolKit");
      mkdirSync(toolkit, { recursive: true });
      const database = join(toolkit, "Tools-scenario.sqlite");
      execFileSync("sqlite3", [
        database,
        `
        CREATE TABLE Tools (id TEXT, toolType TEXT, sourceContainerId INTEGER, deprecationReplacementId TEXT);
        CREATE TABLE ContainerMetadata (id TEXT);
        CREATE TABLE ContainerMetadataLocalizations (containerId INTEGER, locale TEXT, name TEXT);
        CREATE TABLE ToolLocalizations (toolId INTEGER, localizationUsage TEXT, locale TEXT, name TEXT, descriptionSummary TEXT);
        INSERT INTO ContainerMetadata VALUES ('org.unicli.discovery-scenario');
        INSERT INTO ContainerMetadataLocalizations VALUES (1, 'en', 'Discovery Fixture');
        INSERT INTO Tools VALUES ('org.unicli.discovery-scenario.action', 'appIntent', 1, NULL);
        INSERT INTO ToolLocalizations VALUES (1, 'display', 'en', 'Alpha', '${queries.alpha}');
      `,
      ]);
      invalidateCache();
      const userManifestCommand = {
        name: command("alpha"),
        description: "cataloglifecycleuseroverride",
        type: "desktop",
        source_tier: "user" as const,
        args: [{ name: "token", type: "str" as const, required: true }],
      };
      const userDocuments = manifestSearchDocuments({
        version: "scenario",
        sites: {
          macos: { category: "desktop", commands: [userManifestCommand] },
        },
      });
      outcomes.push({
        scenario:
          "Fast-path user overlay suppresses replaced inventory metadata",
        passed: searchDocuments(userDocuments, queries.alpha, 8).length === 0,
      });
      outcomes.push({
        scenario: "Fast-path discovery retains the user's required argument",
        passed: searchDocuments(
          userDocuments,
          "cataloglifecycleuseroverride",
          8,
        ).some(
          (result) =>
            result.command === command("alpha") &&
            result.description === userManifestCommand.description &&
            result.usage.endsWith(" --token <str>"),
        ),
      });
      outcomes.push({
        scenario: "Removing a user overlay restores the cached inventory entry",
        passed: searchDocuments([], queries.alpha, 8).some(
          (result) => result.command === command("alpha"),
        ),
      });
      registerMacosDynamicCommands();
      primeKernelCache();
      outcomes.push({
        scenario: "Created inventory action reaches search and execution",
        passed: await inspect(queries.alpha, "alpha", queries.alpha),
      });
      const created = searchDocuments([], queries.alpha, 8);
      outcomes.push({
        scenario: "Manifest discovery finds the created inventory action",
        passed: created.some((result) => result.command === command("alpha")),
      });
      const registryVersion = getRegistryVersion();
      search(queries.alpha, 8);
      outcomes.push({
        scenario: "Repeated live search reuses the registry snapshot",
        passed: getRegistryVersion() === registryVersion,
      });

      execFileSync("sqlite3", [
        database,
        `UPDATE ToolLocalizations SET name = 'Beta', descriptionSummary = '${queries.beta}';`,
      ]);
      outcomes.push({
        scenario: "Unexpired inventory remains consistent across consumers",
        passed:
          JSON.stringify(searchDocuments([], queries.alpha, 8)) ===
            JSON.stringify(created) &&
          (await inspect(queries.alpha, "alpha", queries.alpha)),
      });
      invalidateMacosDynamicCache();
      outcomes.push({
        scenario: "Refreshed inventory reaches search and execution",
        passed: await inspect(queries.beta, "beta", queries.beta),
      });
      outcomes.push({
        scenario: "Manifest index follows the inventory refresh",
        passed: searchDocuments([], queries.beta, 8).some(
          (result) => result.command === command("beta"),
        ),
      });
      outcomes.push({
        scenario: "Renamed command leaves both discovery paths and the kernel",
        passed:
          search(queries.alpha, 8).length === 0 &&
          searchDocuments([], queries.alpha, 8).length === 0 &&
          resolveCommand("macos", command("alpha")) === undefined &&
          getCompiled("macos", command("alpha")) === undefined &&
          buildInvocation("mcp", "macos", command("alpha"), {
            args: {},
            source: "mcp",
          }) === null,
      });

      const compiledBeta = getCompiled("macos", command("beta"));
      execFileSync("sqlite3", [
        database,
        `UPDATE ToolLocalizations SET descriptionSummary = '${queries.edited}';`,
      ]);
      invalidateMacosDynamicCache();
      outcomes.push({
        scenario: "Stable command key executes refreshed action metadata",
        passed: await inspect(queries.edited, "beta", queries.edited),
      });
      outcomes.push({
        scenario: "Stable argument contract reuses its compiled validator",
        passed: getCompiled("macos", command("beta")) === compiledBeta,
      });

      process.env.UNICLI_DYNAMIC_MACOS = "0";
      outcomes.push({
        scenario: "Disable removes dynamic search results and invocation keys",
        passed:
          search(queries.edited, 8).length === 0 &&
          searchDocuments([], queries.edited, 8).length === 0 &&
          getCompiled("macos", command("beta")) === undefined &&
          resolveCommand("macos", command("beta")) === undefined,
      });
      process.env.UNICLI_DYNAMIC_MACOS = "1";
      invalidateCache();
      outcomes.push({
        scenario:
          "Reenable rebuilds discovery and execution from persisted data",
        passed: await inspect(queries.edited, "beta", queries.edited),
      });
      const child = JSON.parse(
        execFileSync(
          process.execPath,
          ["--import", "tsx", fileURLToPath(import.meta.url), "--restart"],
          { encoding: "utf8", env: process.env },
        ),
      ) as { outcomes: typeof outcomes };
      outcomes.push(...child.outcomes);

      execFileSync("sqlite3", [database, "DELETE FROM Tools;"]);
      invalidateMacosDynamicCache();
      outcomes.push({
        scenario: "Deletion removes discovery, resolution, and compiled state",
        passed:
          search(queries.edited, 8).length === 0 &&
          searchDocuments([], queries.edited, 8).length === 0 &&
          resolveCommand("macos", command("beta")) === undefined &&
          getCompiled("macos", command("beta")) === undefined,
      });

      execFileSync("sqlite3", [
        database,
        "INSERT INTO Tools VALUES ('org.unicli.discovery-scenario.action', 'appIntent', 1, NULL);",
      ]);
      invalidateMacosDynamicCache();
      search(queries.edited, 8);
      registerAdapter({
        name: "macos",
        type: AdapterType.DESKTOP,
        commands: {
          [command("beta")]: {
            name: command("beta"),
            description: "cataloglifecycleuseroverride",
            source_tier: "user",
            adapter_path: join(
              home,
              ".unicli",
              "adapters",
              "macos",
              "override.ts",
            ),
            adapterArgs: [{ name: "token", type: "str", required: true }],
            func: async (_page, args) => ({ owner: "user", token: args.token }),
          },
        },
      });
      primeKernelCache();
      const userCompiled = getCompiled("macos", command("beta"));
      invalidateMacosDynamicCache();
      outcomes.push({
        scenario: "User command takes precedence over refreshed inventory",
        passed:
          search("cataloglifecycleuseroverride", 8).some(
            (result) =>
              result.command === command("beta") &&
              result.description === "cataloglifecycleuseroverride",
          ) &&
          search(queries.edited, 8).length === 0 &&
          resolveCommand("macos", command("beta"))?.command.source_tier ===
            "user" &&
          getCompiled("macos", command("beta")) === userCompiled,
      });
      const userInvocation = buildInvocation(
        "mcp",
        "macos",
        command("beta"),
        { args: { token: "scenario" }, source: "mcp" },
        { permissionProfile: "locked", approved: true },
      );
      const userResult = userInvocation
        ? await execute(userInvocation)
        : undefined;
      outcomes.push({
        scenario: "User command executes with its own argument schema",
        passed:
          userResult?.exitCode === 0 &&
          userResult.results.some(
            (row) => row.owner === "user" && row.token === "scenario",
          ),
      });
      process.env.UNICLI_DYNAMIC_MACOS = "0";
      outcomes.push({
        scenario: "Disabling inventory preserves the user command",
        passed:
          search("cataloglifecycleuseroverride", 8).some(
            (result) => result.command === command("beta"),
          ) && getCompiled("macos", command("beta")) === userCompiled,
      });
    }
    console.log(
      JSON.stringify({ scenarios: outcomes.length, outcomes }, null, 2),
    );
    if (outcomes.some((outcome) => !outcome.passed)) process.exitCode = 1;
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousFlag === undefined) delete process.env.UNICLI_DYNAMIC_MACOS;
    else process.env.UNICLI_DYNAMIC_MACOS = previousFlag;
    if (previousLogging === undefined) delete process.env.UNICLI_NO_LOG;
    else process.env.UNICLI_NO_LOG = previousLogging;
    if (!restart) rmSync(home, { recursive: true, force: true });
  }
}
