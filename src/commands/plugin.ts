/**
 * Plugin CLI subcommands — install/uninstall/list/update/create third-party plugins.
 *
 * Commands:
 *   plugin install <source>  — Install from GitHub or local path
 *   plugin uninstall <name>  — Remove an installed plugin
 *   plugin list              — List all installed plugins (adapters + manifest)
 *   plugin update [name]     — Update one or all plugins
 *   plugin create <name>     — Scaffold a new plugin with unicli-plugin.json
 *   plugin steps             — List custom pipeline steps from plugins
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  installPlugin,
  uninstallPlugin,
  listPlugins,
  updatePlugin,
} from "../plugin.js";
import { createPlugin, listManifestPlugins } from "../plugin/loader.js";
import { listCustomSteps } from "../plugin/step-registry.js";

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
      const legacyPlugins = listPlugins();
      const manifestPlugins = listManifestPlugins();

      // Deduplicate: manifest plugins override legacy entries with same name
      const manifestNames = new Set(manifestPlugins.map((p) => p.name));
      const legacyOnly = legacyPlugins.filter(
        (p) => !manifestNames.has(p.name),
      );

      if (legacyOnly.length === 0 && manifestPlugins.length === 0) {
        console.log("No plugins installed.");
        return;
      }

      for (const p of manifestPlugins) {
        console.log(
          `  ${chalk.bold(p.name)} v${p.version} — ${p.description ?? ""} ${chalk.dim("[manifest]")}`,
        );
      }
      for (const p of legacyOnly) {
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

  plugin
    .command("create <name>")
    .description("Scaffold a new plugin with unicli-plugin.json manifest")
    .action((name: string) => {
      try {
        const dir = createPlugin(name);
        console.log(chalk.green(`Created plugin scaffold at ${dir}`));
        console.log(
          chalk.dim("  Edit unicli-plugin.json and add adapters/steps."),
        );
      } catch (err) {
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exitCode = 1;
      }
    });

  plugin
    .command("steps")
    .description("List custom pipeline steps registered by plugins")
    .action(() => {
      const steps = listCustomSteps();
      if (steps.length === 0) {
        console.log("No custom pipeline steps registered.");
        return;
      }
      console.log(`${steps.length} custom step(s):`);
      for (const s of steps) {
        console.log(`  - ${s}`);
      }
    });
}
