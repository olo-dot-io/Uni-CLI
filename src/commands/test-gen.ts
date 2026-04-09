/**
 * Test generation command — auto-generate Vitest tests from evals.
 *
 * Commands:
 *   unicli test generate <site>    — auto-generate test from eval + current output
 *   unicli test ci --changed       — test only adapters changed in current commit
 */

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export function registerTestGenCommand(program: Command): void {
  const testCmd = program
    .command("test-gen")
    .description("Auto-generate adapter tests");

  testCmd
    .command("generate <site>")
    .description("Generate Vitest test from eval file and current output")
    .option("--output <dir>", "output directory", "tests/adapters")
    .action((site: string, opts: { output: string }) => {
      // Find eval files for this site
      const evalDirs = ["evals/smoke", "evals/regression"];
      let evalFile: string | undefined;

      for (const dir of evalDirs) {
        const candidate = join(dir, `${site}.yaml`);
        if (existsSync(candidate)) {
          evalFile = candidate;
          break;
        }
      }

      if (!evalFile) {
        console.error(
          chalk.yellow(
            `No eval file found for ${site}. Create one at evals/smoke/${site}.yaml first.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      const evalContent = readFileSync(evalFile, "utf-8");

      // Extract command names from eval file
      const cmdMatches = evalContent.match(
        /command:\s*unicli\s+(\S+)\s+(\S+)/g,
      );
      if (!cmdMatches || cmdMatches.length === 0) {
        console.error(chalk.yellow(`No commands found in ${evalFile}`));
        process.exitCode = 1;
        return;
      }

      const commands: Array<{ site: string; cmd: string }> = [];
      for (const match of cmdMatches) {
        const parts = match.match(/unicli\s+(\S+)\s+(\S+)/);
        if (parts) {
          commands.push({ site: parts[1], cmd: parts[2] });
        }
      }

      // Generate Vitest test file
      mkdirSync(opts.output, { recursive: true });
      const testPath = join(opts.output, `${site}.test.ts`);

      const testLines = [
        `// Auto-generated adapter test for ${site}`,
        `// Source eval: ${evalFile}`,
        `import { describe, it, expect } from "vitest";`,
        `import { execFileSync } from "node:child_process";`,
        ``,
        `describe("${site} adapters", () => {`,
      ];

      for (const { site: s, cmd } of commands) {
        testLines.push(`  it("${cmd} returns non-empty data", () => {`);
        testLines.push(`    const result = execFileSync(`);
        testLines.push(
          `      "node", ["dist/main.js", "${s}", "${cmd}", "--json"],`,
        );
        testLines.push(`      { encoding: "utf-8", timeout: 30_000 },`);
        testLines.push(`    );`);
        testLines.push(`    const data = JSON.parse(result);`);
        testLines.push(`    expect(data).toBeTruthy();`);
        testLines.push(`    if (Array.isArray(data)) {`);
        testLines.push(`      expect(data.length).toBeGreaterThan(0);`);
        testLines.push(`    }`);
        testLines.push(`  });`);
        testLines.push(``);
      }

      testLines.push(`});`);
      testLines.push(``);

      writeFileSync(testPath, testLines.join("\n"), "utf-8");
      console.log(
        chalk.green(`Generated ${testPath} (${commands.length} test cases)`),
      );
    });

  testCmd
    .command("ci")
    .description("Test only adapters changed in current commit")
    .option("--changed", "test changed adapters only", true)
    .action((_opts: { changed: boolean }) => {
      // Find changed adapter files
      let changedFiles: string[];
      try {
        const diff = execFileSync("git", ["diff", "--name-only", "HEAD~1"], {
          encoding: "utf-8",
        }) as string;
        changedFiles = diff.trim().split("\n").filter(Boolean);
      } catch {
        console.error(chalk.yellow("Cannot determine changed files"));
        process.exitCode = 1;
        return;
      }

      // Extract site names from changed adapter paths
      const sites = new Set<string>();
      for (const file of changedFiles) {
        const match = file.match(/src\/adapters\/([^/]+)\//);
        if (match) sites.add(match[1]);
      }

      if (sites.size === 0) {
        console.log(chalk.dim("No adapter changes detected."));
        return;
      }

      console.log(
        chalk.cyan(
          `Testing ${sites.size} changed adapter(s): ${[...sites].join(", ")}`,
        ),
      );

      for (const site of sites) {
        try {
          const result = execFileSync(
            "sh",
            ["-c", `unicli eval run ${site} 2>&1`],
            { encoding: "utf-8", timeout: 60_000 },
          ) as string;
          console.log(`  ${chalk.green("✓")} ${site}: ${result.trim()}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${chalk.red("✗")} ${site}: ${msg}`);
          process.exitCode = 1;
        }
      }
    });
}
