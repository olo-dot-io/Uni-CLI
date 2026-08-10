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
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  installPlugin,
  uninstallPlugin,
  listPlugins,
  updatePlugin,
} from "../plugin.js";
import {
  createPlugin,
  installedPluginsDir,
  listManifestPlugins,
  listPortablePlugins,
} from "../plugin/loader.js";
import { inspectAgentPlugin } from "../plugin/agent-plugin.js";
import { detectFormat, format } from "../output/formatter.js";
import { makeCtx } from "../output/envelope.js";
import type { OutputFormat } from "../types.js";
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
      const portablePlugins = listPortablePlugins();

      const portableNames = new Set(
        portablePlugins.map((plugin) => plugin.manifest.name),
      );
      const nativeOnly = manifestPlugins.filter(
        (plugin) => !portableNames.has(plugin.name),
      );
      const manifestNames = new Set([
        ...manifestPlugins.map((plugin) => plugin.name),
        ...portableNames,
      ]);
      const legacyOnly = legacyPlugins.filter(
        (p) => !manifestNames.has(p.name),
      );

      if (
        legacyOnly.length === 0 &&
        manifestPlugins.length === 0 &&
        portablePlugins.length === 0
      ) {
        console.log("No plugins installed.");
        return;
      }

      for (const p of portablePlugins) {
        const hasNativeRuntime = manifestPlugins.some(
          (plugin) => plugin.name === p.manifest.name,
        );
        console.log(
          `  ${chalk.bold(p.manifest.name)} v${p.manifest.version ?? "unversioned"} — ${p.manifest.description ?? ""} ${chalk.dim(`[Agent Plugins 1.0, ${p.skills.length} skills${hasNativeRuntime ? ", Uni-CLI runtime" : ""}]`)}`,
        );
      }
      for (const p of nativeOnly) {
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
    .command("inspect <path>")
    .description("Inspect an Agent Plugins 1.0 package and runtime projection")
    .action((path: string) => {
      const startedAt = Date.now();
      const fmt = detectFormat(
        program.opts().format as OutputFormat | undefined,
      );
      try {
        const root = existsSync(path)
          ? path
          : join(installedPluginsDir(), path);
        const inspection = inspectAgentPlugin(root);
        console.log(
          format(
            {
              ...inspection,
              skills: inspection.skills.map((skill) => ({
                name: skill.name,
                description: skill.description,
                path: skill.path,
                activation: "instructions",
                allowed_tools: skill.allowedTools,
              })),
            },
            undefined,
            fmt,
            makeCtx("plugin.inspect", startedAt),
          ),
        );
      } catch (error) {
        const context = makeCtx("plugin.inspect", startedAt);
        context.error = {
          code: "invalid_input",
          message: error instanceof Error ? error.message : String(error),
          suggestion:
            "Pass a plugin root containing a valid Agent Plugins 1.0 plugin.json.",
          retryable: false,
        };
        console.error(format(null, undefined, fmt, context));
        process.exitCode = 2;
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
    .description("Scaffold Agent Plugins 1.0 plus Uni-CLI runtime extension")
    .action((name: string) => {
      try {
        const dir = createPlugin(name);
        console.log(chalk.green(`Created plugin scaffold at ${dir}`));
        console.log(
          chalk.dim(
            "  Edit plugin.json for portable skills and unicli-plugin.json for adapters/steps.",
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
