import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userHome } from "../engine/user-home.js";

export interface EndpointMemory {
  url: string;
  method: string;
  params?: unknown;
  response?: unknown;
  verified_at: string;
  notes?: string;
}

export interface FieldMemory {
  meaning: string;
  source: string;
  verified_at: string;
}

export interface SiteMemory {
  endpoints: Record<string, EndpointMemory>;
  fieldMap: Record<string, FieldMemory>;
  notes: string;
}

export interface SiteMemoryWriteOptions {
  baseDir?: string;
  verifiedAt?: string;
}

export interface DiscoveredEndpoint {
  url: string;
  method: string;
  status: number;
  contentType: string;
  responseBody?: string;
  size: number;
  detectedFields: string[];
  capability?: string;
}

export function siteMemoryPaths(
  site: string,
  baseDir = userHome(),
): {
  dir: string;
  endpoints: string;
  fieldMap: string;
  notes: string;
  fixturesDir: string;
  verifyDir: string;
} {
  const dir = join(baseDir, ".unicli", "sites", site);
  return {
    dir,
    endpoints: join(dir, "endpoints.json"),
    fieldMap: join(dir, "field-map.json"),
    notes: join(dir, "notes.md"),
    fixturesDir: join(dir, "fixtures"),
    verifyDir: join(dir, "verify"),
  };
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function readSiteMemory(
  site: string,
  opts: { baseDir?: string } = {},
): SiteMemory {
  const paths = siteMemoryPaths(site, opts.baseDir);
  return {
    endpoints: readJson<Record<string, EndpointMemory>>(paths.endpoints, {}),
    fieldMap: readJson<Record<string, FieldMemory>>(paths.fieldMap, {}),
    notes: existsSync(paths.notes) ? readFileSync(paths.notes, "utf-8") : "",
  };
}

export function writeEndpointMemory(
  site: string,
  key: string,
  endpoint: Omit<EndpointMemory, "verified_at"> & { verified_at?: string },
  opts: SiteMemoryWriteOptions = {},
): void {
  const paths = siteMemoryPaths(site, opts.baseDir);
  const existing = readJson<Record<string, EndpointMemory>>(
    paths.endpoints,
    {},
  );
  existing[key] = {
    ...endpoint,
    verified_at: endpoint.verified_at ?? opts.verifiedAt ?? today(),
  };
  writeJson(paths.endpoints, existing);
}

export function mergeFieldMap(
  site: string,
  fields: Record<string, { meaning: string; source: string }>,
  opts: SiteMemoryWriteOptions = {},
): void {
  const paths = siteMemoryPaths(site, opts.baseDir);
  const existing = readJson<Record<string, FieldMemory>>(paths.fieldMap, {});
  for (const [key, value] of Object.entries(fields)) {
    if (existing[key]) continue;
    existing[key] = {
      ...value,
      verified_at: opts.verifiedAt ?? today(),
    };
  }
  writeJson(paths.fieldMap, existing);
}

export function appendSiteNote(
  site: string,
  note: string,
  opts: { baseDir?: string; date?: string; author?: string } = {},
): void {
  const paths = siteMemoryPaths(site, opts.baseDir);
  mkdirSync(paths.dir, { recursive: true });
  const previous = existsSync(paths.notes)
    ? readFileSync(paths.notes, "utf-8")
    : "";
  const header = `## ${opts.date ?? today()} by ${opts.author ?? "unicli"}\n\n`;
  writeFileSync(paths.notes, `${header}${note.trim()}\n\n${previous}`, "utf-8");
}

function endpointKey(endpoint: DiscoveredEndpoint): string {
  if (endpoint.capability) return endpoint.capability;
  try {
    const parts = new URL(endpoint.url).pathname
      .split("/")
      .filter(Boolean)
      .filter((part) => part !== "api" && !/^v\d+$/i.test(part));
    return parts.slice(-2).join("-") || "data";
  } catch {
    return "data";
  }
}

function parseSample(responseBody: string | undefined): unknown {
  if (!responseBody) return undefined;
  try {
    return JSON.parse(responseBody);
  } catch {
    return responseBody.slice(0, 10_000);
  }
}

export function recordEndpointDiscoveries(
  site: string,
  endpoints: DiscoveredEndpoint[],
  opts: SiteMemoryWriteOptions = {},
): void {
  const fieldMap: Record<string, { meaning: string; source: string }> = {};
  const keys: string[] = [];

  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);
    keys.push(key);
    writeEndpointMemory(
      site,
      key,
      {
        url: endpoint.url,
        method: endpoint.method,
        response: {
          status: endpoint.status,
          contentType: endpoint.contentType,
          size: endpoint.size,
          fields: endpoint.detectedFields,
          sample: parseSample(endpoint.responseBody),
        },
        notes: endpoint.capability
          ? `Detected capability: ${endpoint.capability}`
          : "Discovered from browser network capture",
      },
      opts,
    );
    for (const field of endpoint.detectedFields) {
      fieldMap[field] = { meaning: field, source: "discovery" };
    }
  }

  mergeFieldMap(site, fieldMap, opts);
  if (endpoints.length > 0) {
    appendSiteNote(
      site,
      `Recorded ${endpoints.length} discovered endpoint(s): ${keys.join(", ")}`,
      {
        baseDir: opts.baseDir,
        date: opts.verifiedAt,
      },
    );
  }
}
