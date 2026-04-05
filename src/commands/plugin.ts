/**
 * Plugin CLI subcommands — install/uninstall/list/update third-party adapters.
 *
 * Commands:
 *   plugin install <source>  — Install from GitHub or local path
 *   plugin uninstall <name>  — Remove an installed plugin
 *   plugin list              — List all installed plugins
 *   plugin update [name]     — Update one or all plugins
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  installPlugin,
  uninstallPlugin,
  listPlugins,
  updatePlugin,
} from "../plugin.js";

export function registerPluginCommands(program: Command): void {
  const plugin = program
    .command("plugin")
    .description("Manage third-party adapter plugins");

  plugin
    .command("install <source>")
    .description("Install a plugin (github:user/repo, URL, or local path)")
    .action((source: string) => {
      try {
        const info = installPlugin(source);
        console.log(
          chalk.green(
            `Installed "${info.name}" (${info.commands} adapters) → ${info.path}`,
          ),
        );
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
      }
    });

  plugin
    .command("uninstall <name>")
    .description("Uninstall a plugin")
    .action((name: string) => {
      try {
        uninstallPlugin(name);
        console.log(chalk.green(`Uninstalled "${name}"`));
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
      }
    });

  plugin
    .command("list")
    .description("List installed plugins")
    .action(() => {
      const plugins = listPlugins();
      if (plugins.length === 0) {
        console.log("No plugins installed.");
        return;
      }
      for (const p of plugins) {
        console.log(
          `  ${chalk.bold(p.name)} — ${p.commands} adapters ${chalk.dim(p.source ?? "")}`,
        );
      }
    });

  plugin
    .command("update [name]")
    .description("Update a plugin (or all)")
    .action((name?: string) => {
      try {
        if (name) {
          const info = updatePlugin(name);
          console.log(
            chalk.green(`Updated "${info.name}" (${info.commands} adapters)`),
          );
        } else {
          const plugins = listPlugins();
          for (const p of plugins) {
            try {
              updatePlugin(p.name);
              console.log(chalk.green(`  ✓ ${p.name}`));
            } catch (err) {
              console.log(
                chalk.red(
                  `  ✗ ${p.name}: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
            }
          }
        }
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
      }
    });
}
