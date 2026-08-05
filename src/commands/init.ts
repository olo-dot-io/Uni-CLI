/**
 * Init command — scaffold new adapter YAML files from templates.
 *
 * Usage:
 *   unicli init <site> <command> [-t web-api|bridge|browser|desktop|service]
 *
 * Creates a ready-to-edit YAML adapter in src/adapters/<site>/<command>.yaml
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TEMPLATES: Record<string, string> = {
  "web-api": [
    "site: {{site}}",
    "name: {{name}}",
    "description: TODO",
    "type: web-api",
    "strategy: public",
    "",
    "pipeline:",
    "  - fetch:",
    '      url: "https://{{site}}.com/api/{{name}}"',
    '  - select: "data"',
    "  - map:",
    '      id: "${{ item.id }}"',
    '      title: "${{ item.title }}"',
    "  - limit: 20",
    "",
    "columns: [id, title]",
    "",
    'capabilities: ["http.fetch"]',
    "minimum_capability: http.fetch",
    "trust: public",
    "confidentiality: public",
    "quarantine: false",
    "schema_version: v2",
    "",
  ].join("\n"),
  bridge: [
    "site: {{site}}",
    "name: {{name}}",
    "description: TODO",
    "type: bridge",
    "strategy: public",
    "binary: {{site}}",
    "detect: which {{site}}",
    "",
    "pipeline:",
    "  - exec:",
    "      command: {{site}}",
    "      args:",
    "        - {{name}}",
    "        - --json",
    "      parse: json",
    "      timeout: 30000",
    "",
    "columns: [id, name]",
    "",
    'capabilities: ["subprocess.exec"]',
    "minimum_capability: subprocess.exec",
    "trust: user",
    "confidentiality: public",
    "quarantine: false",
    "schema_version: v2",
    "",
  ].join("\n"),
  browser: [
    "site: {{site}}",
    "name: {{name}}",
    "description: TODO",
    "type: browser",
    "strategy: intercept",
    "",
    "pipeline:",
    "  - navigate:",
    '      url: "https://{{site}}.com"',
    "  - intercept:",
    '      pattern: "/api/"',
    "      wait: 3000",
    '  - select: "data"',
    "  - limit: 20",
    "",
    "columns: [id, title]",
    "",
    'capabilities: ["cdp-browser.navigate", "cdp-browser.intercept"]',
    "minimum_capability: cdp-browser.intercept",
    "trust: public",
    "confidentiality: internal",
    "quarantine: false",
    "schema_version: v2",
    "",
  ].join("\n"),
  desktop: [
    "site: {{site}}",
    "name: {{name}}",
    "description: TODO",
    "type: desktop",
    "strategy: public",
    "",
    "pipeline:",
    "  - exec:",
    "      command: {{site}}",
    "      args:",
    "        - {{name}}",
    "      parse: json",
    "      timeout: 30000",
    "",
    "columns: [id, name]",
    "",
    'capabilities: ["subprocess.exec"]',
    "minimum_capability: subprocess.exec",
    "trust: user",
    "confidentiality: public",
    "quarantine: false",
    "schema_version: v2",
    "",
  ].join("\n"),
  service: [
    "site: {{site}}",
    "name: {{name}}",
    "description: TODO",
    "type: service",
    "strategy: public",
    "",
    "pipeline:",
    "  - websocket:",
    '      url: "ws://localhost:4455"',
    '      send: \'{"op": 6, "d": {}}\'',
    "      timeout: 5000",
    "",
    "columns: [type, data]",
    "",
    'capabilities: ["net.websocket"]',
    "minimum_capability: net.websocket",
    "trust: public",
    "confidentiality: public",
    "quarantine: false",
    "schema_version: v2",
    "",
  ].join("\n"),
};

export function registerInitCommand(program: Command): void {
  program
    .command("init <site> <command>")
    .description("Scaffold a new adapter YAML file")
    .option(
      "-t, --type <type>",
      "Adapter type (web-api|bridge|browser|desktop|service)",
      "web-api",
    )
    .option("-o, --output <dir>", "Output directory", "src/adapters")
    .action(
      (
        site: string,
        command: string,
        opts: { type: string; output: string },
      ) => {
        const template = TEMPLATES[opts.type];
        if (!template) {
          console.error(
            chalk.red(
              `Unknown type: ${opts.type}. Valid: ${Object.keys(TEMPLATES).join(", ")}`,
            ),
          );
          process.exitCode = 2;
          return;
        }

        const yaml = template
          .replace(/\{\{site\}\}/g, site)
          .replace(/\{\{name\}\}/g, command);

        const dir = join(opts.output, site);
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `${command}.yaml`);

        if (existsSync(filePath)) {
          console.error(chalk.red(`File already exists: ${filePath}`));
          process.exitCode = 1;
          return;
        }

        writeFileSync(filePath, yaml, "utf-8");
        console.log(chalk.green(`Created ${filePath}`));
        console.log(
          chalk.dim(`Edit the file, then test with: unicli ${site} ${command}`),
        );
      },
    );
}
