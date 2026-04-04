/**
 * Adapter loader — discovers and registers YAML + TS adapters.
 *
 * Scan order:
 *   1. Built-in adapters from src/adapters/
 *   2. User adapters from ~/.unicli/adapters/
 *   3. Plugin adapters from ~/.unicli/plugins/
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { registerAdapter } from '../registry.js';
import type { AdapterManifest, AdapterCommand, AdapterArg, AdapterType, PipelineStep } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, '..', 'adapters');
const USER_DIR = join(process.env.HOME ?? '~', '.unicli', 'adapters');

interface YamlAdapter {
  site: string;
  name: string;
  description?: string;
  domain?: string;
  strategy?: string;
  browser?: boolean;
  type?: string;
  binary?: string;
  detect?: string;
  base?: string;
  health?: string;
  auth?: string;
  autoInstall?: string;
  passthrough?: boolean;
  args?: Record<string, YamlArg>;
  pipeline?: PipelineStep[];
  columns?: string[];
  // Desktop
  execArgs?: string[];
  // Web
  method?: string;
  path?: string;
  url?: string;
  params?: Record<string, unknown>;
  // Browser
  navigate?: string;
  wait?: string;
  extract?: string;
  output?: string | Record<string, unknown>;
}

interface YamlArg {
  type?: string;
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
}

/** Load all adapters from a directory */
export function loadAdaptersFromDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;

  for (const site of readdirSync(dir)) {
    if (site.startsWith('_') || site.startsWith('.')) continue;
    const siteDir = join(dir, site);
    if (!statSync(siteDir).isDirectory()) continue;

    const commands: Record<string, AdapterCommand> = {};
    let siteType: AdapterType = 'web-api' as AdapterType;
    let siteMeta: Partial<AdapterManifest> = {};

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      const cmdName = basename(file, ext);

      if (ext === '.yaml' || ext === '.yml') {
        const raw = readFileSync(join(siteDir, file), 'utf-8');
        const parsed = yaml.load(raw) as YamlAdapter;

        if (parsed.type) siteType = parsed.type as AdapterType;
        if (parsed.domain) siteMeta.domain = parsed.domain;
        if (parsed.strategy) siteMeta.strategy = parsed.strategy as AdapterManifest['strategy'];
        if (parsed.browser !== undefined) siteMeta.browser = parsed.browser;
        if (parsed.binary) siteMeta.binary = parsed.binary;
        if (parsed.base) siteMeta.base = parsed.base;
        if (parsed.detect) siteMeta.detect = parsed.detect;
        if (parsed.auth) siteMeta.auth = parsed.auth as AdapterManifest['auth'];
        if (parsed.autoInstall) siteMeta.autoInstall = parsed.autoInstall;
        if (parsed.passthrough !== undefined) siteMeta.passthrough = parsed.passthrough;

        // Parse args from YAML into AdapterArg[]
        let adapterArgs: AdapterArg[] | undefined;
        if (parsed.args) {
          adapterArgs = Object.entries(parsed.args).map(([argName, argDef]) => ({
            name: argName,
            type: (argDef.type as AdapterArg['type']) ?? 'str',
            default: argDef.default,
            required: argDef.required ?? false,
            positional: argDef.positional ?? false,
            choices: argDef.choices,
            description: argDef.description,
          }));
        }

        commands[cmdName] = {
          name: cmdName,
          description: parsed.description,
          pipeline: parsed.pipeline,
          adapterArgs,
          columns: parsed.columns,
          method: parsed.method as AdapterCommand['method'],
          path: parsed.path,
          url: parsed.url,
          params: parsed.params,
          navigate: parsed.navigate,
          wait: parsed.wait,
          extract: parsed.extract,
          execArgs: parsed.execArgs,
        };
        count++;
      }
    }

    if (Object.keys(commands).length > 0) {
      registerAdapter({
        name: site,
        type: siteType,
        commands,
        ...siteMeta,
      });
    }
  }

  return count;
}

/** Load all adapters: built-in → user → plugins */
export function loadAllAdapters(): number {
  let total = 0;
  total += loadAdaptersFromDir(BUILTIN_DIR);
  total += loadAdaptersFromDir(USER_DIR);
  return total;
}
