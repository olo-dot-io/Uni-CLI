/** Agent Plugins 1.0 package inspection and Skill projection. */

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { parseSkillFile, type Skill } from "../protocol/skill.js";
import { registerAdapter } from "../registry.js";
import { AdapterType, type AdapterCommand } from "../types.js";

export const AGENT_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const UNICLI_AGENT_PLUGIN_NAMESPACE = "dev.unicli";

const pluginFields = new Set([
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
const manifestSchema = z
  .object({
    $schema: z.literal(AGENT_PLUGIN_SCHEMA),
    name: z.string().min(1),
    version: z.string().optional(),
    description: z.string().optional(),
    author: z
      .object({
        name: z.string().optional(),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    extensions: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .passthrough();
const mcpSchema = z
  .object({
    $schema: z.literal(AGENT_PLUGIN_MCP_SCHEMA),
    mcpServers: z.record(z.string(), z.unknown()),
  })
  .strict();

export type AgentPluginManifest = z.infer<typeof manifestSchema>;

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
    servers: Record<string, { type: string }>;
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
  const { manifest, issues } = validateManifest(
    parseJson(manifestPath, "plugin manifest"),
    manifestPath,
  );
  const skills = discoverPluginSkills(root, issues);
  const mcp = inspectMcp(root, issues);
  const site = portablePluginSite(manifest.name);
  return {
    spec_version: "1.0.0",
    root,
    manifest_path: manifestPath,
    manifest,
    skills,
    mcp,
    projected_operations: skills.map((skill) => `${site}.${skill.name}`),
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

export function portablePluginSite(name: string): string {
  return `agent-plugin.${name}`;
}

export function assertAgentPluginName(name: string): void {
  if (
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
  if (!isRecord(value)) {
    throw new AgentPluginError(
      "manifest_invalid",
      "plugin.json must be a JSON object",
      path,
    );
  }
  if (value.$schema !== AGENT_PLUGIN_SCHEMA) {
    throw new AgentPluginError(
      "unsupported_version",
      `unsupported Agent Plugins schema: ${String(value.$schema)}`,
      path,
    );
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid plugin.json: ${z.prettifyError(parsed.error)}`,
      path,
    );
  }
  assertAgentPluginName(parsed.data.name);
  const issues = Object.keys(value)
    .filter((key) => !pluginFields.has(key))
    .map((key) => ({
      severity: "warning" as const,
      component: "manifest" as const,
      message: `ignored unknown plugin.json field: ${key}`,
      path,
    }));
  const manifest = Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => pluginFields.has(key)),
  ) as AgentPluginManifest;
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
    if (!statSync(resolvedSkills).isDirectory()) {
      throw new Error("not a directory");
    }
    assertContained(root, resolvedSkills);
  } catch (error) {
    issues.push(issue("error", "skills", error, skillsPath));
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
      issues.push(
        issue(
          "warning",
          "skills",
          `skipped skill ${entry.name}: ${errorMessage(error)}`,
          skillPath,
        ),
      );
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function inspectMcp(
  root: string,
  issues: AgentPluginIssue[],
): AgentPluginInspection["mcp"] {
  const path = join(root, "mcp.json");
  const result: AgentPluginInspection["mcp"] = {
    path: existsSync(path) ? path : null,
    valid: true,
    servers: {},
    runtime_support: "configuration-only",
  };
  if (!result.path) return result;
  try {
    const parsed = mcpSchema.parse(
      parseJson(containedFile(root, path), "mcp configuration"),
    );
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      if (
        !isRecord(value) ||
        !["stdio", "streamable-http", "sse"].includes(String(value.type))
      ) {
        issues.push(
          issue(
            "warning",
            "mcp",
            `skipped MCP server ${name}: unsupported descriptor`,
            path,
          ),
        );
        continue;
      }
      result.servers[name] = { type: String(value.type) };
    }
  } catch (error) {
    result.valid = false;
    issues.push(issue("error", "mcp", error, path));
  }
  return result;
}

function validatePortableSkill(skill: Skill, directoryName: string): void {
  const name = skill.raw.name;
  const description = skill.raw.description;
  if (
    typeof name !== "string" ||
    name.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) ||
    name.includes("--") ||
    name !== directoryName
  ) {
    throw new Error(
      "skill name must match its directory and use 1-64 lowercase alphanumeric or hyphen characters",
    );
  }
  if (
    typeof description !== "string" ||
    description.length < 1 ||
    description.length > 1_024
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
  if (
    skill.raw.metadata !== undefined &&
    (!isRecord(skill.raw.metadata) ||
      Object.values(skill.raw.metadata).some(
        (entry) => typeof entry !== "string",
      ))
  ) {
    throw new Error("skill metadata must be an object of strings");
  }
  if (
    skill.raw["allowed-tools"] !== undefined &&
    typeof skill.raw["allowed-tools"] !== "string"
  ) {
    throw new Error("skill allowed-tools must be a space-separated string");
  }
}

function realpathDirectory(path: string): string {
  try {
    const root = realpathSync(resolve(path));
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid Agent Plugin root: ${errorMessage(error)}`,
      path,
    );
  }
}

function containedFile(root: string, path: string): string {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isFile()) throw new Error("not a regular file");
    assertContained(root, resolved);
    return resolved;
  } catch (error) {
    if (error instanceof AgentPluginError) throw error;
    throw new AgentPluginError(
      "manifest_invalid",
      `invalid plugin file ${path}: ${errorMessage(error)}`,
      path,
    );
  }
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
      `invalid ${label}: ${errorMessage(error)}`,
      path,
    );
  }
}

function issue(
  severity: AgentPluginIssue["severity"],
  component: AgentPluginIssue["component"],
  error: unknown,
  path: string,
): AgentPluginIssue {
  return { severity, component, message: errorMessage(error), path };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
