/**
 * @owner   src/core/yaml-adapter.ts
 * @does    Normalize one parsed YAML adapter document into the command descriptor shared by live loading, fast user overlays, and manifest generation.
 * @needs   schema-v2 and portable adapter types
 * @feeds   discovery loader, fast-path manifest, build-manifest
 * @breaks  Invalid schema-v2 or argument definitions are returned as typed normalization failures; callers choose CLI/server reporting policy.
 * @invariants A given parsed document, command name, source path, and source tier produce one identical command descriptor on every surface.
 * @side-effects none
 * @perf    O(document fields + arguments + pipeline steps)
 * @concurrency pure and reentrant
 * @test    tests/unit/loader.test.ts, tests/unit/fast-path.test.ts
 * @stability internal
 * @since   2026-07-30
 */

import { validateAdapterV2, type AdapterCommandV2 } from "./schema-v2.js";
import {
  type AdapterArg,
  type AdapterCommand,
  type AdapterManifest,
  type AdapterType,
  type BrowserSessionPreference,
  type PipelineStep,
  type RetrievalMetadata,
} from "../types.js";

export interface YamlAdapterDocument {
  site?: string;
  name?: string;
  description?: string;
  domain?: string;
  strategy?: string;
  browser?: boolean;
  browserSession?: BrowserSessionPreference;
  type?: string;
  binary?: string;
  detect?: string;
  base?: string;
  health?: string;
  auth?: string;
  autoInstall?: string;
  passthrough?: boolean;
  auth_cookies?: string[];
  args?: Record<string, YamlArgDocument>;
  pipeline?: PipelineStep[];
  columns?: string[];
  quarantine?: boolean;
  quarantineReason?: string;
  paginated?: boolean;
  operation_effect?: AdapterCommand["operation_effect"];
  execution_operator?: AdapterCommand["execution_operator"];
  operation_family?: AdapterCommand["operation_family"];
  idempotency?: AdapterCommand["idempotency"];
  target_surface?: AdapterCommand["target_surface"];
  execArgs?: string[];
  executables?: string[];
  method?: string;
  path?: string;
  url?: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  navigate?: string;
  wait?: string;
  extract?: string;
  output?: AdapterCommand["output"];
  capabilities?: string[];
  auth_requirement?: AdapterCommand["auth_requirement"];
  retrieval?: RetrievalMetadata;
  minimum_capability?: string;
  trust?: string;
  confidentiality?: string;
  defaultFormat?: AdapterCommand["defaultFormat"];
  stream?: boolean;
}

export interface YamlArgDocument extends Omit<
  AdapterArg,
  "name" | "type" | "positional"
> {
  type?: AdapterArg["type"];
  positional?: boolean;
}

export type YamlAdapterNormalization =
  | {
      ok: true;
      document: YamlAdapterDocument;
      validated: AdapterCommandV2;
      command: AdapterCommand;
    }
  | { ok: false; error: string };

export function normalizeYamlAdapterDocument(
  value: unknown,
  commandName: string,
  adapterPath: string,
  sourceTier: AdapterCommand["source_tier"],
): YamlAdapterNormalization {
  if (!isRecord(value)) {
    return { ok: false, error: "(root): expected an object" };
  }
  const document = value as YamlAdapterDocument;
  const candidate: Record<string, unknown> = {
    ...value,
    name: commandName,
    capabilities: Array.isArray(document.capabilities)
      ? document.capabilities
      : [],
    minimum_capability:
      typeof document.minimum_capability === "string"
        ? document.minimum_capability
        : "http.fetch",
    trust: typeof document.trust === "string" ? document.trust : "public",
    confidentiality:
      typeof document.confidentiality === "string"
        ? document.confidentiality
        : "public",
    quarantine:
      typeof document.quarantine === "boolean" ? document.quarantine : false,
  };
  const validation = validateAdapterV2(candidate);
  if (!validation.ok) return validation;

  const adapterArgs = normalizeArguments(document.args);
  if (!adapterArgs.ok) return adapterArgs;
  const validated = validation.data;
  return {
    ok: true,
    document,
    validated,
    command: {
      name: commandName,
      description: document.description,
      adapter_path: adapterPath,
      source_tier: sourceTier,
      target_surface: document.target_surface,
      operation_effect: document.operation_effect,
      execution_operator: document.execution_operator,
      operation_family: document.operation_family,
      idempotency: document.idempotency,
      quarantine: document.quarantine === true ? true : undefined,
      quarantineReason: document.quarantineReason,
      minimum_capability: validated.minimum_capability,
      capabilities: stringArray(document.capabilities),
      auth_requirement: document.auth_requirement,
      retrieval: validated.retrieval,
      executables: stringArray(document.executables),
      paginated: document.paginated === true ? true : undefined,
      pipeline: document.pipeline,
      adapterArgs: adapterArgs.args,
      strategy: document.strategy as AdapterCommand["strategy"],
      browser: document.browser,
      browserSession: document.browserSession,
      domain: document.domain,
      base: document.base,
      method: document.method as AdapterCommand["method"],
      path: document.path,
      url: document.url,
      params: document.params,
      body: document.body,
      headers: document.headers,
      navigate: document.navigate,
      wait: document.wait,
      extract: document.extract,
      execArgs: document.execArgs,
      output: document.output,
      columns: stringArray(document.columns),
      defaultFormat: document.defaultFormat,
      stream: document.stream,
    },
  };
}

export function yamlSiteMetadata(document: YamlAdapterDocument): {
  type?: AdapterType;
  meta: Partial<AdapterManifest>;
} {
  return {
    type: document.type as AdapterType | undefined,
    meta: {
      domain: document.domain,
      strategy: document.strategy as AdapterManifest["strategy"],
      browser: document.browser,
      binary: document.binary,
      base: document.base,
      detect: document.detect,
      auth: document.auth as AdapterManifest["auth"],
      autoInstall: document.autoInstall,
      passthrough: document.passthrough,
      authCookies: stringArray(document.auth_cookies),
    },
  };
}

function normalizeArguments(
  args: YamlAdapterDocument["args"],
): { ok: true; args?: AdapterArg[] } | { ok: false; error: string } {
  if (args === undefined) return { ok: true };
  if (!isRecord(args)) return { ok: false, error: "args: expected an object" };
  const normalized: AdapterArg[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (!isRecord(value)) {
      return { ok: false, error: `args.${name}: expected an object` };
    }
    const definition = value as YamlArgDocument;
    normalized.push({
      name,
      type: definition.type ?? "str",
      default: definition.default,
      required: definition.required ?? false,
      positional: definition.positional ?? false,
      choices: stringArray(definition.choices),
      description: definition.description,
      minimum: definition.minimum,
      maximum: definition.maximum,
      minLength: definition.minLength,
      maxLength: definition.maxLength,
      pattern: definition.pattern,
      format: definition.format,
      "x-unicli-kind": definition["x-unicli-kind"],
      "x-unicli-accepts": definition["x-unicli-accepts"],
      "x-unicli-uri-origins": definition["x-unicli-uri-origins"],
      "x-unicli-uri-path-pattern": definition["x-unicli-uri-path-pattern"],
    });
  }
  return { ok: true, args: normalized };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
