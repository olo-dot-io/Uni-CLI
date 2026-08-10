/** Agent Plugins 1.0 package inspection and Skill projection. */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseSkillFile, type Skill } from "../protocol/skill.js";
import { registerAdapter } from "../registry.js";
import { AdapterType, type AdapterCommand } from "../types.js";
import { userDataRoot } from "../engine/user-home.js";

export const AGENT_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const UNICLI_AGENT_PLUGIN_NAMESPACE = "dev.unicli";

const PLUGIN_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

export interface AgentPluginManifest {
  $schema: typeof AGENT_PLUGIN_SCHEMA;
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, Record<string, unknown>>;
}

export type AgentPluginMcpServer =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "streamable-http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

export interface AgentPluginIssue {
  severity: "warning" | "error";
  component: "manifest" | "skills" | "mcp";
  message: string;
  path?: string;
}

export interface AgentPluginInspection {
  spec_version: "1.0.0";
  root: string;
  manifest_path: string;
  manifest: AgentPluginManifest;
  skills: Skill[];
  mcp: {
    path: string | null;
    valid: boolean;
    servers: Record<string, AgentPluginMcpServer>;
    runtime_support: "configuration-only";
  };
  projected_operations: string[];
  issues: AgentPluginIssue[];
}

export class AgentPluginError extends Error {
  constructor(
    public readonly code:
      | "manifest_invalid"
      | "unsupported_version"
      | "path_escape",
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "AgentPluginError";
  }
}

export function inspectAgentPlugin(pluginRoot: string): AgentPluginInspection {
  const root = realpathDirectory(pluginRoot);
  const manifestPath = containedFile(root, join(root, "plugin.json"));
  const parsed = parseJson(manifestPath, "plugin manifest");
  const { manifest, issues } = validateManifest(parsed, manifestPath);
  const skills = discoverPluginSkills(root, issues);
  const mcp = inspectMcp(root, manifest, issues);
  const site = portablePluginSite(manifest.name);
  const projectedOperations = skills.map((skill) => `${site}.${skill.name}`);
  if (Object.keys(mcp.servers).length > 0) {
    projectedOperations.push(`${site}.__mcp_servers`);
  }
  return {
    spec_version: "1.0.0",
    root,
    manifest_path: manifestPath,
    manifest,
    skills,
    mcp,
    projected_operations: projectedOperations,
    issues,
  };
}

export function registerAgentPluginSkills(
  inspection: AgentPluginInspection,
): string[] {
  const commands: Record<string, AdapterCommand> = {};
  for (const skill of inspection.skills) {
    commands[skill.name] = {
      name: skill.name,
      description: skill.description,
      adapter_path: skill.path,
      source_tier: "runtime",
      target_surface: "system",
      operation_effect: "read",
      execution_operator: "local-runtime",
      func: async () => ({
        plugin: inspection.manifest.name,
        skill: skill.name,
        instructions: skill.body,
        path: skill.path,
        resource_root: dirname(skill.path),
        allowed_tools: [...skill.allowedTools],
      }),
    };
  }
  const mcpServers = Object.entries(inspection.mcp.servers);
  if (mcpServers.length > 0) {
    commands.__mcp_servers = {
      name: "__mcp_servers",
      description:
        "Inspect portable MCP server descriptors from this Agent Plugin",
      adapter_path: inspection.mcp.path ?? inspection.manifest_path,
      source_tier: "runtime",
      target_surface: "system",
      operation_effect: "read",
      execution_operator: "local-runtime",
      func: async () => ({
        plugin: inspection.manifest.name,
        runtime_support: inspection.mcp.runtime_support,
        servers: mcpServers.map(([name, server]) => ({
          name,
          type: server.type,
          ...(server.type === "stdio"
            ? {
                command: server.command,
                ...(server.cwd ? { cwd: server.cwd } : {}),
                has_args: (server.args?.length ?? 0) > 0,
                has_env: Object.keys(server.env ?? {}).length > 0,
              }
            : {
                url: server.url,
                has_headers: Object.keys(server.headers ?? {}).length > 0,
              }),
        })),
      }),
    };
  }
  if (Object.keys(commands).length === 0) return [];
  registerAdapter({
    name: portablePluginSite(inspection.manifest.name),
    displayName: `${inspection.manifest.name} Agent Plugin`,
    description: inspection.manifest.description,
    version: inspection.manifest.version,
    type: AdapterType.SERVICE,
    category: "agent-plugin",
    commands,
  });
  return [...inspection.projected_operations];
}

export function listAgentPlugins(
  pluginsDir = join(userDataRoot(), "plugins"),
): AgentPluginInspection[] {
  if (!existsSync(pluginsDir)) return [];
  const inspections: AgentPluginInspection[] = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = join(pluginsDir, entry.name);
    if (!existsSync(join(root, "plugin.json"))) continue;
    try {
      inspections.push(inspectAgentPlugin(root));
    } catch {
      continue;
    }
  }
  return inspections.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
}

export function portablePluginSite(name: string): string {
  return `agent-plugin.${name}`;
}

export function assertAgentPluginName(name: string): void {
  if (
    name.length < 1 ||
    name.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) ||
    name.includes("--") ||
    name.includes("..")
  ) {
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid Agent Plugin name: ${name}`,
    );
  }
}

function validateManifest(
  value: unknown,
  path: string,
): { manifest: AgentPluginManifest; issues: AgentPluginIssue[] } {
  const record = recordValue(value, "plugin.json", path);
  if (record.$schema !== AGENT_PLUGIN_SCHEMA) {
    throw new AgentPluginError(
      "unsupported_version",
      `unsupported Agent Plugins schema: ${String(record.$schema)}`,
      path,
    );
  }
  const name = requiredString(record.name, "plugin name", path);
  try {
    assertAgentPluginName(name);
  } catch (error) {
    if (error instanceof AgentPluginError) {
      throw new AgentPluginError(error.code, error.message, path);
    }
    throw error;
  }
  const issues: AgentPluginIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!PLUGIN_FIELDS.has(key)) {
      issues.push({
        severity: "warning",
        component: "manifest",
        message: `ignored unknown plugin.json field: ${key}`,
        path,
      });
    }
  }
  const manifest: AgentPluginManifest = { $schema: AGENT_PLUGIN_SCHEMA, name };
  for (const field of [
    "version",
    "description",
    "homepage",
    "repository",
    "license",
  ] as const) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== "string") {
      throw new AgentPluginError(
        "manifest_invalid",
        `plugin.json ${field} must be a string`,
        path,
      );
    }
    manifest[field] = record[field];
  }
  if (record.keywords !== undefined) {
    if (
      !Array.isArray(record.keywords) ||
      record.keywords.some((entry) => typeof entry !== "string")
    ) {
      throw new AgentPluginError(
        "manifest_invalid",
        "plugin.json keywords must be an array of strings",
        path,
      );
    }
    manifest.keywords = [...record.keywords] as string[];
  }
  if (record.author !== undefined) {
    const author = recordValue(record.author, "plugin author", path);
    const unknown = Object.keys(author).filter(
      (key) => !["name", "email", "url"].includes(key),
    );
    if (
      unknown.length > 0 ||
      Object.values(author).some((entry) => typeof entry !== "string")
    ) {
      throw new AgentPluginError(
        "manifest_invalid",
        "plugin.json author may contain only string name, email, and url fields",
        path,
      );
    }
    manifest.author = author as AgentPluginManifest["author"];
  }
  if (record.extensions !== undefined) {
    if (!isRecord(record.extensions)) {
      issues.push({
        severity: "warning",
        component: "manifest",
        message: "ignored non-object plugin.json extensions field",
        path,
      });
    } else {
      for (const [namespace, extension] of Object.entries(record.extensions)) {
        if (!isRecord(extension)) {
          throw new AgentPluginError(
            "manifest_invalid",
            `plugin extension ${namespace} must be an object`,
            path,
          );
        }
      }
      manifest.extensions = record.extensions as Record<
        string,
        Record<string, unknown>
      >;
    }
  }
  return { manifest, issues };
}

function discoverPluginSkills(
  root: string,
  issues: AgentPluginIssue[],
): Skill[] {
  const skillsPath = join(root, "skills");
  if (!existsSync(skillsPath)) return [];
  let resolvedSkills: string;
  try {
    resolvedSkills = realpathSync(skillsPath);
    if (!statSync(resolvedSkills).isDirectory())
      throw new Error("not a directory");
    assertContained(root, resolvedSkills);
  } catch (error) {
    issues.push({
      severity: "error",
      component: "skills",
      message: `invalid skills component: ${error instanceof Error ? error.message : String(error)}`,
      path: skillsPath,
    });
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of readdirSync(resolvedSkills, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = join(resolvedSkills, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const resolved = containedFile(root, skillPath);
      const skill = parseSkillFile(resolved, "plugin");
      if (!skill) throw new Error("invalid Agent Skill frontmatter");
      validatePortableSkill(skill, entry.name);
      skills.push(skill);
    } catch (error) {
      issues.push({
        severity: "warning",
        component: "skills",
        message: `skipped skill ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        path: skillPath,
      });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function inspectMcp(
  root: string,
  manifest: AgentPluginManifest,
  issues: AgentPluginIssue[],
): AgentPluginInspection["mcp"] {
  const path = join(root, "mcp.json");
  if (!existsSync(path)) {
    return {
      path: null,
      valid: true,
      servers: {},
      runtime_support: "configuration-only",
    };
  }
  let record: Record<string, unknown>;
  try {
    const resolved = containedFile(root, path);
    record = recordValue(
      parseJson(resolved, "mcp configuration"),
      "mcp.json",
      resolved,
    );
    if (
      record.$schema !== AGENT_PLUGIN_MCP_SCHEMA ||
      Object.keys(record).some(
        (key) => !["$schema", "mcpServers"].includes(key),
      ) ||
      !isRecord(record.mcpServers)
    ) {
      throw new Error("mcp.json has an unsupported schema or top-level shape");
    }
  } catch (error) {
    issues.push({
      severity: "error",
      component: "mcp",
      message: error instanceof Error ? error.message : String(error),
      path,
    });
    return {
      path,
      valid: false,
      servers: {},
      runtime_support: "configuration-only",
    };
  }
  if (
    manifest.$schema.replace("plugin.schema", "mcp.schema") !== record.$schema
  ) {
    issues.push({
      severity: "error",
      component: "mcp",
      message: "mcp.json targets a different Agent Plugins version",
      path,
    });
    return {
      path,
      valid: false,
      servers: {},
      runtime_support: "configuration-only",
    };
  }
  const servers: Record<string, AgentPluginMcpServer> = {};
  for (const [name, value] of Object.entries(record.mcpServers)) {
    try {
      servers[name] = validateMcpServer(root, value, name);
    } catch (error) {
      issues.push({
        severity: "warning",
        component: "mcp",
        message: `skipped MCP server ${name}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      });
    }
  }
  return {
    path,
    valid: true,
    servers,
    runtime_support: "configuration-only",
  };
}

function validateMcpServer(
  root: string,
  value: unknown,
  name: string,
): AgentPluginMcpServer {
  const record = recordValue(value, `MCP server ${name}`);
  if (record.type === "stdio") {
    closedFields(record, ["type", "command", "args", "env", "cwd"], name);
    const command = requiredString(
      record.command,
      `MCP server ${name} command`,
    );
    if (command.startsWith("./")) {
      assertPluginRelativePath(root, command);
    } else if (
      isAbsolute(command) ||
      command.startsWith("../") ||
      command.includes("/") ||
      command.includes("\\") ||
      command.includes("${")
    ) {
      throw new Error("stdio command must be a bare executable or ./ path");
    }
    const args = optionalStringArray(record.args, "args");
    const env = optionalStringRecord(record.env, "env");
    if (
      env &&
      Object.keys(env).some((key) => /^(PLUGIN_ROOT|PLUGIN_DATA)$/i.test(key))
    ) {
      throw new Error("stdio env cannot override PLUGIN_ROOT or PLUGIN_DATA");
    }
    const cwd = record.cwd;
    if (cwd !== undefined) {
      if (typeof cwd !== "string" || !validPluginCwd(root, cwd)) {
        throw new Error("stdio cwd is outside PLUGIN_ROOT or PLUGIN_DATA");
      }
    }
    return {
      type: "stdio",
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
    };
  }
  if (record.type === "streamable-http" || record.type === "sse") {
    closedFields(record, ["type", "url", "headers"], name);
    const url = new URL(requiredString(record.url, `MCP server ${name} url`));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol === "http:" && !isLoopback(url.hostname))
    ) {
      throw new Error(
        "remote MCP URL must use HTTPS without userinfo or fragment",
      );
    }
    const headers = optionalStringRecord(record.headers, "headers");
    if (headers) {
      const names = new Set<string>();
      for (const [header, headerValue] of Object.entries(headers)) {
        const lowered = header.toLowerCase();
        if (
          names.has(lowered) ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header) ||
          /[\r\n]/.test(headerValue)
        ) {
          throw new Error("invalid or duplicate MCP header");
        }
        names.add(lowered);
      }
    }
    return {
      type: record.type,
      url: url.toString(),
      ...(headers ? { headers } : {}),
    };
  }
  throw new Error(`unsupported MCP transport: ${String(record.type)}`);
}

function validPluginCwd(root: string, cwd: string): boolean {
  if (cwd === "${PLUGIN_ROOT}") return true;
  if (cwd.startsWith("${PLUGIN_ROOT}/")) {
    return safeContainedPath(
      root,
      resolve(root, cwd.slice("${PLUGIN_ROOT}/".length)),
    );
  }
  if (cwd === "${PLUGIN_DATA}" || cwd.startsWith("${PLUGIN_DATA}/")) {
    return !cwd.slice("${PLUGIN_DATA}".length).split(/[\\/]/).includes("..");
  }
  return cwd.startsWith("./") && safeContainedPath(root, resolve(root, cwd));
}

function validatePortableSkill(skill: Skill, directoryName: string): void {
  const rawName = skill.raw.name;
  const rawDescription = skill.raw.description;
  if (
    typeof rawName !== "string" ||
    rawName.length < 1 ||
    rawName.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(rawName) ||
    rawName.includes("--") ||
    rawName !== directoryName
  ) {
    throw new Error(
      "skill name must match its directory and use 1-64 lowercase alphanumeric or hyphen characters",
    );
  }
  if (
    typeof rawDescription !== "string" ||
    rawDescription.length < 1 ||
    rawDescription.length > 1_024
  ) {
    throw new Error("skill description must contain 1-1024 characters");
  }
  if (
    skill.raw.license !== undefined &&
    typeof skill.raw.license !== "string"
  ) {
    throw new Error("skill license must be a string");
  }
  if (
    skill.raw.compatibility !== undefined &&
    (typeof skill.raw.compatibility !== "string" ||
      skill.raw.compatibility.length < 1 ||
      skill.raw.compatibility.length > 500)
  ) {
    throw new Error("skill compatibility must contain 1-500 characters");
  }
  if (skill.raw.metadata !== undefined) {
    if (
      !isRecord(skill.raw.metadata) ||
      Object.values(skill.raw.metadata).some(
        (value) => typeof value !== "string",
      )
    ) {
      throw new Error("skill metadata must be an object of strings");
    }
  }
  if (
    skill.raw["allowed-tools"] !== undefined &&
    typeof skill.raw["allowed-tools"] !== "string"
  ) {
    throw new Error("skill allowed-tools must be a space-separated string");
  }
}

function assertPluginRelativePath(root: string, value: string): void {
  const path = resolve(root, value);
  if (!safeContainedPath(root, path)) {
    throw new Error("plugin-relative path escapes PLUGIN_ROOT");
  }
}

function safeContainedPath(root: string, path: string): boolean {
  if (!isContained(root, path)) return false;
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  try {
    return isContained(root, realpathSync(existing));
  } catch {
    return false;
  }
}

function realpathDirectory(path: string): string {
  try {
    const root = realpathSync(resolve(path));
    if (!statSync(root).isDirectory())
      throw new Error("plugin root is not a directory");
    return root;
  } catch (error) {
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid Agent Plugin root: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

function containedFile(root: string, path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid plugin file ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  assertContained(root, resolved);
  return resolved;
}

function assertContained(root: string, path: string): void {
  if (!isContained(root, path)) {
    throw new AgentPluginError(
      "path_escape",
      `plugin path escapes its root: ${path}`,
      path,
    );
  }
}

function isContained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
  );
}

function parseJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (error) {
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
}

function recordValue(
  value: unknown,
  label: string,
  path?: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AgentPluginError(
      "manifest_invalid",
      `${label} must be a JSON object`,
      path,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string, path?: string): string {
  if (typeof value !== "string" || !value) {
    throw new AgentPluginError(
      "manifest_invalid",
      `${label} must be a non-empty string`,
      path,
    );
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function optionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${label} must be an object of strings`);
  }
  return { ...value } as Record<string, string>;
}

function closedFields(
  record: Record<string, unknown>,
  allowed: string[],
  name: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(
      `MCP server ${name} has unknown fields: ${unknown.join(", ")}`,
    );
  }
}

function isLoopback(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const normalized = hostname.startsWith("[")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  if (isIP(normalized) === 6) return normalized === "::1";
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
