/**
 * Adapter marketplace commands — install, update, and list community adapters.
 *
 * Uses GitHub raw URLs as a lightweight registry:
 *   adapter install <site>/<command>  — fetch YAML from registry
 *   adapter update [site]             — refresh installed adapters
 *   adapter list                      — show what's installed locally
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/olo-dot-io/unicli-registry/main";

function userAdapterDir(): string {
  return join(process.env.HOME ?? "~", ".unicli", "adapters");
}

export function registerAdapterCommands(program: Command): void {
  const adapter = program
    .command("adapter")
    .description("Manage community adapters");

  adapter
    .command("install <spec>")
    .description("Install adapter from registry (site/command)")
    .action(async (spec: string) => {
      const [site, cmd] = spec.split("/");
      if (!site || !cmd) {
        console.error(
          chalk.red("Usage: unicli adapter install <site>/<command>"),
        );
        process.exitCode = 2;
        return;
      }

      const url = `${REGISTRY_URL}/adapters/${site}/${cmd}.yaml`;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) {
          console.error(chalk.red(`Adapter ${spec} not found in registry`));
          process.exitCode = 1;
          return;
        }
        const yaml = await resp.text();
        const dir = join(userAdapterDir(), site);
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `${cmd}.yaml`);
        writeFileSync(filePath, yaml, "utf-8");
        console.log(chalk.green(`Installed ${spec} → ${filePath}`));
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
      }
    });

  adapter
    .command("update [site]")
    .description("Update installed adapters from registry")
    .action(async (site?: string) => {
      const dir = userAdapterDir();
      if (!existsSync(dir)) {
        console.log(chalk.yellow("No user adapters installed"));
        return;
      }
      console.log(chalk.dim("Adapter update from registry — coming soon"));
      if (site) console.log(chalk.dim(`Would update: ${site}`));
    });

  adapter
    .command("list")
    .description("List installed user adapters")
    .action(() => {
      const dir = userAdapterDir();
      if (!existsSync(dir)) {
        console.log(chalk.yellow("No user adapters installed"));
        return;
      }

      const sites = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      if (sites.length === 0) {
        console.log(chalk.yellow("No user adapters installed"));
        return;
      }

      for (const s of sites) {
        const cmds = readdirSync(join(dir, s))
          .filter((f) => f.endsWith(".yaml"))
          .map((f) => f.replace(".yaml", ""));
        console.log(`${chalk.green(s)}: ${cmds.join(", ")}`);
      }
    });
}
