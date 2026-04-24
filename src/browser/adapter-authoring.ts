import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { siteMemoryPaths } from "./site-memory.js";
import { fixturePath } from "./verify-fixture.js";

export interface AdapterTarget {
  site: string;
  command: string;
}

export interface CreateAdapterOptions {
  baseDir?: string;
  force?: boolean;
}

export interface CreateAdapterResult {
  site: string;
  command: string;
  adapterPath: string;
  created: boolean;
  next: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function parseAdapterTarget(target: string): AdapterTarget {
  const [site, command, extra] = target.split("/");
  if (!site || !command || extra) {
    throw new Error(
      `Expected adapter target as <site>/<command>, got "${target}"`,
    );
  }
  if (!NAME_RE.test(site) || !NAME_RE.test(command)) {
    throw new Error(
      `Invalid adapter target "${target}". Use lowercase kebab-case names.`,
    );
  }
  return { site, command };
}

function userAdapterPath(
  site: string,
  command: string,
  baseDir = homedir(),
): string {
  return join(baseDir, ".unicli", "adapters", site, `${command}.yaml`);
}

export function buildAdapterSkeleton(site: string, command: string): string {
  const url = `https://${site}.com/api/${command}`;
  return (
    [
      `site: ${site}`,
      `name: ${command}`,
      `description: "Generated adapter skeleton for ${site} ${command}"`,
      "type: web-api",
      "strategy: public",
      "capabilities: [http.fetch]",
      "minimum_capability: http.fetch",
      "trust: public",
      "confidentiality: public",
      "quarantine: false",
      "pipeline:",
      "  - fetch:",
      `      url: "${url}"`,
      '  - limit: "${{ args.limit | default(20) }}"',
      "args:",
      "  limit:",
      "    type: int",
      "    default: 20",
      "columns: []",
    ].join("\n") + "\n"
  );
}

export function createAdapterSkeleton(
  target: string,
  opts: CreateAdapterOptions = {},
): CreateAdapterResult {
  const { site, command } = parseAdapterTarget(target);
  const adapterPath = userAdapterPath(site, command, opts.baseDir);
  const alreadyExists = existsSync(adapterPath);
  if (!alreadyExists || opts.force === true) {
    mkdirSync(dirname(adapterPath), { recursive: true });
    writeFileSync(adapterPath, buildAdapterSkeleton(site, command), "utf-8");
  }
  return {
    site,
    command,
    adapterPath,
    created: !alreadyExists || opts.force === true,
    next: `Edit ${adapterPath}, then run: unicli browser verify ${site}/${command} --write-fixture`,
  };
}

export function missingStrictMemoryFiles(
  site: string,
  command: string,
  baseDir = homedir(),
): string[] {
  const paths = siteMemoryPaths(site, baseDir);
  return [
    paths.endpoints,
    paths.notes,
    fixturePath(site, command, baseDir),
  ].filter((path) => !existsSync(path));
}
