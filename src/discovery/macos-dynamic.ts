import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getAdapter, registerAdapter } from "../registry.js";
import { AdapterType, type AdapterCommand } from "../types.js";

const execFileAsync = promisify(execFile);

const DYNAMIC_SHORTCUTS_ADAPTER_PATH = "dynamic:macos-shortcuts";
const DYNAMIC_APP_ACTIONS_ADAPTER_PATH = "dynamic:macos-app-actions";
const TOOLKIT_QUERY_TIMEOUT_MS = 3000;
const SHORTCUTS_QUERY_TIMEOUT_MS = 3000;
const SHORTCUT_RUN_TIMEOUT_MS = 120_000;
const MAX_TOOLKIT_OUTPUT_BYTES = 20 * 1024 * 1024;

export interface MacosShortcut {
  name: string;
  identifier?: string;
}

export interface MacosAppAction {
  id: string;
  kind: string;
  containerId: string;
  app: string;
  name: string;
  description: string;
}

export interface MacosDynamicData {
  shortcuts: MacosShortcut[];
  appActions: MacosAppAction[];
}

export interface MacosDynamicSearchDocument {
  site: "macos";
  command: string;
  description: string;
}

export interface MacosActionListOptions {
  app?: string;
  query?: string;
  limit?: number;
}

export interface MacosLayerSmoke {
  layer: "cli" | "api" | "ax";
  ok: boolean;
  count: number;
  sample: string[];
  message: string;
}

export interface MacosAppSmoke {
  app: string;
  apiActions: number;
  axRunning: boolean;
  sampleActions: string[];
}

export interface MacosAutomationSmoke {
  layers: MacosLayerSmoke[];
  apps: MacosAppSmoke[];
}

interface ToolKitActionRow {
  id?: unknown;
  kind?: unknown;
  container_id?: unknown;
  containerId?: unknown;
  app?: unknown;
  name?: unknown;
  description?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function includesNeedle(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function hashSuffix(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function slugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function commandName(
  prefix: string,
  parts: string[],
  fallback: string,
): string {
  const slug = parts.map(slugPart).filter(Boolean).join("-");
  return `${prefix}-${slug || hashSuffix(fallback)}`;
}

function uniqueCommandName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  const name = `${base}-${suffix}`;
  used.add(name);
  return name;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeLocale(value: string | undefined): string {
  const raw = (value ?? "en").split(".")[0].replace("-", "_");
  return /^[A-Za-z_]+$/.test(raw) ? raw : "en";
}

function currentShortcutsLocale(): string {
  return normalizeLocale(
    process.env.LC_ALL ||
      process.env.LC_MESSAGES ||
      process.env.LANG ||
      Intl.DateTimeFormat().resolvedOptions().locale,
  );
}

export function dynamicMacosDiscoveryEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flag = env.UNICLI_DYNAMIC_MACOS?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (platform !== "darwin") return false;
  if (env.NODE_ENV === "test" || env.VITEST) return flag === "1";
  return true;
}

export function parseShortcutsListOutput(stdout: string): MacosShortcut[] {
  const shortcuts: MacosShortcut[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = /^(.*)\s+\(([0-9a-fA-F-]{36})\)$/.exec(line);
    if (match) {
      shortcuts.push({ name: match[1].trim(), identifier: match[2] });
    } else {
      shortcuts.push({ name: line });
    }
  }
  return shortcuts;
}

export function parseToolKitActionsJson(stdout: string): MacosAppAction[] {
  if (!stdout.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const actions: MacosAppAction[] = [];

  for (const row of parsed as ToolKitActionRow[]) {
    if (!row || typeof row !== "object") continue;
    const id = stringValue(row.id);
    const app = stringValue(row.app);
    const name = stringValue(row.name);
    if (!id || !name) continue;

    const action: MacosAppAction = {
      id,
      kind: stringValue(row.kind) || "appIntent",
      containerId:
        stringValue(row.container_id) || stringValue(row.containerId) || app,
      app: app || stringValue(row.container_id) || id,
      name,
      description: stringValue(row.description),
    };

    const key = `${action.id}\0${action.containerId}\0${action.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }

  return actions;
}

function findToolKitDatabase(home = homedir()): string | undefined {
  const dir = join(home, "Library", "Shortcuts", "ToolKit");
  if (!existsSync(dir)) return undefined;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // REASON: macOS Shortcuts data is a user permission boundary; absence or EPERM means ToolKit dynamic actions are unavailable.
    return undefined;
  }

  const files = names
    .filter((file) => /^Tools-.*\.sqlite$/.test(file))
    .flatMap((file) => {
      const path = join(dir, file);
      try {
        return [{ path, mtimeMs: statSync(path).mtimeMs }];
      } catch {
        // REASON: ToolKit database files can be rotated or permission-gated between directory read and stat.
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files[0]?.path;
}

function toolKitActionsQuery(locale: string): string {
  const preferred = escapeSqlString(locale);
  return `
SELECT
  Tools.id AS id,
  Tools.toolType AS kind,
  ContainerMetadata.id AS container_id,
  COALESCE(
    (SELECT name FROM ContainerMetadataLocalizations WHERE containerId = ContainerMetadata.rowId AND locale = '${preferred}' LIMIT 1),
    (SELECT name FROM ContainerMetadataLocalizations WHERE containerId = ContainerMetadata.rowId AND locale = 'en' LIMIT 1),
    (SELECT name FROM ContainerMetadataLocalizations WHERE containerId = ContainerMetadata.rowId LIMIT 1),
    ContainerMetadata.id
  ) AS app,
  COALESCE(
    (SELECT name FROM ToolLocalizations WHERE toolId = Tools.rowId AND localizationUsage = 'display' AND locale = '${preferred}' LIMIT 1),
    (SELECT name FROM ToolLocalizations WHERE toolId = Tools.rowId AND localizationUsage = 'display' AND locale = 'en' LIMIT 1),
    (SELECT name FROM ToolLocalizations WHERE toolId = Tools.rowId AND localizationUsage = 'display' LIMIT 1),
    Tools.id
  ) AS name,
  COALESCE(
    (SELECT descriptionSummary FROM ToolLocalizations WHERE toolId = Tools.rowId AND localizationUsage = 'display' AND locale = '${preferred}' LIMIT 1),
    (SELECT descriptionSummary FROM ToolLocalizations WHERE toolId = Tools.rowId AND localizationUsage = 'display' AND locale = 'en' LIMIT 1),
    ''
  ) AS description
FROM Tools
JOIN ContainerMetadata ON ContainerMetadata.rowId = Tools.sourceContainerId
WHERE Tools.deprecationReplacementId IS NULL
ORDER BY app, name, id;
`;
}

export function discoverMacosShortcuts(): MacosShortcut[] {
  try {
    const stdout = execFileSync(
      "/usr/bin/shortcuts",
      ["list", "--show-identifiers"],
      {
        encoding: "utf8",
        timeout: SHORTCUTS_QUERY_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseShortcutsListOutput(stdout);
  } catch {
    return [];
  }
}

export function discoverMacosAppActions(): MacosAppAction[] {
  const db = findToolKitDatabase();
  if (!db) return [];

  try {
    const stdout = execFileSync(
      "sqlite3",
      ["-json", db, toolKitActionsQuery(currentShortcutsLocale())],
      {
        encoding: "utf8",
        timeout: TOOLKIT_QUERY_TIMEOUT_MS,
        maxBuffer: MAX_TOOLKIT_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseToolKitActionsJson(stdout);
  } catch {
    return [];
  }
}

export function filterMacosAppActions(
  actions: MacosAppAction[],
  options: MacosActionListOptions = {},
): MacosAppAction[] {
  const app = options.app?.trim();
  const query = options.query?.trim();
  const limit = parsePositiveInt(options.limit, 200);

  return actions
    .filter((action) => !app || includesNeedle(action.app, app))
    .filter(
      (action) =>
        !query ||
        includesNeedle(action.name, query) ||
        includesNeedle(action.description, query) ||
        includesNeedle(action.id, query),
    )
    .slice(0, limit);
}

export function listMacosAppActions(
  options: Record<string, unknown>,
): MacosAppAction[] {
  return filterMacosAppActions(discoverMacosAppActions(), {
    app: stringValue(options.app),
    query: stringValue(options.query),
    limit: parsePositiveInt(options.limit, 200),
  });
}

export function discoverMacosDynamicData(): MacosDynamicData {
  if (!dynamicMacosDiscoveryEnabled()) {
    return { shortcuts: [], appActions: [] };
  }

  return {
    shortcuts: discoverMacosShortcuts(),
    appActions: discoverMacosAppActions(),
  };
}

function discoverRunningAxApps(): string[] {
  if (process.platform !== "darwin") return [];

  try {
    const stdout = execFileSync(
      "osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        [
          "var se = Application('System Events');",
          "var procs = se.applicationProcesses.whose({backgroundOnly: false})();",
          "JSON.stringify(procs.map(function(p) { return p.name(); }));",
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function buildMacosAutomationSmoke(
  data: MacosDynamicData,
  axApps: string[],
  appNames: string[],
): MacosAutomationSmoke {
  const layers: MacosLayerSmoke[] = [
    {
      layer: "cli",
      ok: data.shortcuts.length > 0,
      count: data.shortcuts.length,
      sample: data.shortcuts.slice(0, 5).map((shortcut) => shortcut.name),
      message:
        data.shortcuts.length > 0
          ? "shortcuts CLI returned user shortcuts"
          : "shortcuts CLI returned no shortcuts or is unavailable",
    },
    {
      layer: "api",
      ok: data.appActions.length > 0,
      count: data.appActions.length,
      sample: data.appActions
        .slice(0, 5)
        .map((action) => `${action.app}: ${action.name}`),
      message:
        data.appActions.length > 0
          ? "Shortcuts ToolKit database returned app actions"
          : "Shortcuts ToolKit database returned no actions or is unavailable",
    },
    {
      layer: "ax",
      ok: axApps.length > 0,
      count: axApps.length,
      sample: axApps.slice(0, 5),
      message:
        axApps.length > 0
          ? "System Events returned foreground application processes"
          : "AX/System Events returned no foreground applications or is unavailable",
    },
  ];

  const apps = appNames.map((app) => {
    const matchingActions = data.appActions.filter((action) =>
      includesNeedle(action.app, app),
    );
    return {
      app,
      apiActions: matchingActions.length,
      axRunning: axApps.some((running) => includesNeedle(running, app)),
      sampleActions: matchingActions.slice(0, 5).map((action) => action.name),
    };
  });

  return { layers, apps };
}

export function runMacosAutomationSmoke(
  options: Record<string, unknown>,
): MacosAutomationSmoke {
  const rawApps = stringValue(options.apps);
  const apps = rawApps
    ? rawApps
        .split(",")
        .map((app) => app.trim())
        .filter(Boolean)
    : [
        "Finder",
        "Safari",
        "Mail",
        "Messages",
        "Reminders",
        "Notes",
        "WhatsApp",
      ];

  return buildMacosAutomationSmoke(
    discoverMacosDynamicData(),
    discoverRunningAxApps(),
    apps,
  );
}

async function runShortcut(shortcut: MacosShortcut): Promise<unknown> {
  const target = shortcut.identifier || shortcut.name;
  const { stdout } = await execFileAsync(
    "/usr/bin/shortcuts",
    ["run", target],
    {
      encoding: "utf8",
      timeout: SHORTCUT_RUN_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  return {
    shortcut: shortcut.name,
    identifier: shortcut.identifier,
    output: String(stdout ?? "").trim(),
  };
}

function shortcutCommandDescription(shortcut: MacosShortcut): string {
  return `Run local Shortcuts.app shortcut "${shortcut.name}"`;
}

function appActionCommandDescription(action: MacosAppAction): string {
  const base = `Inspect Shortcuts app action ${action.app} / ${action.name}.`;
  return action.description ? `${base} ${action.description}` : base;
}

export function buildMacosDynamicCommands(
  data: MacosDynamicData,
): Record<string, AdapterCommand> {
  const commands: Record<string, AdapterCommand> = {};
  const used = new Set<string>();

  for (const shortcut of data.shortcuts) {
    const base = commandName(
      "shortcut",
      [shortcut.name],
      shortcut.identifier || shortcut.name,
    );
    const name = uniqueCommandName(base, used);
    commands[name] = {
      name,
      description: shortcutCommandDescription(shortcut),
      adapter_path: DYNAMIC_SHORTCUTS_ADAPTER_PATH,
      target_surface: "system",
      minimum_capability: "subprocess.exec",
      columns: ["shortcut", "identifier", "output"],
      func: async () => runShortcut(shortcut),
    };
  }

  for (const action of data.appActions) {
    const base = commandName(
      "app-action",
      [action.app, action.name],
      action.id,
    );
    const name = uniqueCommandName(base, used);
    commands[name] = {
      name,
      description: appActionCommandDescription(action),
      adapter_path: DYNAMIC_APP_ACTIONS_ADAPTER_PATH,
      target_surface: "desktop",
      minimum_capability: "subprocess.exec",
      columns: ["app", "name", "id", "kind", "description", "executable"],
      func: async () => ({
        ...action,
        executable: false,
        run_command:
          "Create a Shortcut containing this action, then run that shortcut with `unicli macos shortcuts-run <name-or-id>`.",
      }),
    };
  }

  return commands;
}

export function buildMacosDynamicSearchDocuments(
  data: MacosDynamicData,
): MacosDynamicSearchDocument[] {
  const docs: MacosDynamicSearchDocument[] = [];
  const used = new Set<string>();

  docs.push(
    {
      site: "macos",
      command: "app-actions",
      description:
        "List real-time Shortcuts app actions, App Intents, app commands, action identifiers, and automation actions from installed macOS apps.",
    },
    {
      site: "macos",
      command: "automation-smoke",
      description:
        "Probe macOS automation layers across Shortcuts CLI, Shortcuts ToolKit API, Accessibility AX, System Events, and common apps.",
    },
  );

  for (const shortcut of data.shortcuts) {
    const base = commandName(
      "shortcut",
      [shortcut.name],
      shortcut.identifier || shortcut.name,
    );
    const command = uniqueCommandName(base, used);
    docs.push({
      site: "macos",
      command,
      description: `${shortcutCommandDescription(shortcut)} via the macOS shortcuts CLI.`,
    });
  }

  for (const action of data.appActions) {
    const base = commandName(
      "app-action",
      [action.app, action.name],
      action.id,
    );
    const command = uniqueCommandName(base, used);
    docs.push({
      site: "macos",
      command,
      description: `Shortcuts app action from ${action.app}: ${action.name}.${action.description ? ` ${action.description}` : ""}`,
    });
  }

  return docs;
}

export function registerMacosDynamicCommands(): number {
  const data = discoverMacosDynamicData();
  const dynamicCommands = buildMacosDynamicCommands(data);

  let adapter = getAdapter("macos");
  if (!adapter) {
    adapter = {
      name: "macos",
      type: AdapterType.DESKTOP,
      commands: {},
    };
    registerAdapter(adapter);
  }

  for (const [name, command] of Object.entries(adapter.commands)) {
    if (
      command.adapter_path === DYNAMIC_SHORTCUTS_ADAPTER_PATH ||
      command.adapter_path === DYNAMIC_APP_ACTIONS_ADAPTER_PATH
    ) {
      delete adapter.commands[name];
    }
  }

  Object.assign(adapter.commands, dynamicCommands);
  return Object.keys(dynamicCommands).length;
}
