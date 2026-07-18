/**
 * @owner       src::core::schema-v2
 * @does        Validates adapter command schema v2 and migrates legacy command records without overwriting declared metadata.
 * @needs       zod and the portable adapter command contract
 * @feeds       adapter loading, manifest generation, linting, discovery, and runtime execution
 * @breaks      Dropping capability, trust, quarantine, authentication, or retrieval fields makes generated and in-process command truth diverge.
 * @invariants  Migration supplies only absent defaults; explicit required, optional, or none authentication and domain-neutral retrieval metadata survive validation unchanged.
 * @side-effects None.
 * @perf        O(command metadata size) per validation or migration.
 * @concurrency Schemas and migration functions are immutable and safe for concurrent callers.
 * @test        tests/unit/schema-v2.test.ts, tests/unit/loader.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { z } from "zod";

/** Trust level enum — mirrors adapter source provenance. */
export const AdapterTrustSchema = z.enum(["public", "user", "system"]);
export type AdapterTrust = z.infer<typeof AdapterTrustSchema>;

/**
 * Schema version tag. Currently fixed at `"v2"`; when a future breaking
 * migration lands (e.g. v3), we widen the union and keep the loader
 * backward-compatible during the migration window.
 */
export const AdapterSchemaVersionSchema = z.literal("v2");
export type AdapterSchemaVersion = z.infer<typeof AdapterSchemaVersionSchema>;

/** Confidentiality label enum — mirrors data sensitivity classification. */
export const AdapterConfidentialitySchema = z.enum([
  "public",
  "internal",
  "private",
]);
export type AdapterConfidentiality = z.infer<
  typeof AdapterConfidentialitySchema
>;

/**
 * The default capability legacy adapters inherit. `http.fetch` is chosen
 * because the overwhelming majority of v1 YAML adapters are web-api
 * pipelines — the safe, lowest-privilege baseline.
 */
export const AdapterV2DefaultMinimumCapability = "http.fetch" as const;

const RetrievalTokenSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "must be a kebab-case semantic token");

const RetrievalSourceClassSchema = z.enum([
  "official",
  "hosted-artifact",
  "community",
  "search-index",
]);

const RetrievalArgumentsSchema = z.record(
  RetrievalTokenSchema,
  z.string().min(1),
);

const RetrievalMetadataSchema = z
  .object({
    operation: z.literal("discover"),
    result_kind: RetrievalTokenSchema,
    source_class: RetrievalSourceClassSchema,
    arguments: RetrievalArgumentsSchema.optional(),
  })
  .strict();

/**
 * AdapterCommand v2 schema.
 *
 * Kept loose on the legacy fields (name, description, pipeline, ...) because
 * the v1 shape has historical leniency. The v2 layer is strictly validated
 * on the new fields — which is the point of the migration gate.
 */
export const AdapterCommandV2Schema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    // Optional on the parser so legacy v1 -> v2 migration paths can still
    // flow through parseAdapterV2 without a value. The schema-v2 lint
    // (scripts/lint-schema-v2.ts) enforces that every *committed* adapter
    // YAML carries the tag explicitly.
    schema_version: AdapterSchemaVersionSchema.optional(),
    capabilities: z.array(z.string()),
    auth_requirement: z.enum(["required", "optional", "none"]).optional(),
    retrieval: RetrievalMetadataSchema.optional(),
    minimum_capability: z.string().min(1),
    trust: AdapterTrustSchema,
    confidentiality: AdapterConfidentialitySchema,
    quarantine: z.boolean(),
    // Legacy shape fields carried through opaquely — zod.unknown keeps them
    // without forcing a schema for every historical key.
    args: z.record(z.string(), z.unknown()).optional(),
    pipeline: z.array(z.record(z.string(), z.unknown())).optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    navigate: z.string().optional(),
    wait: z.string().optional(),
    extract: z.string().optional(),
    execArgs: z.array(z.string()).optional(),
    executables: z.array(z.string()).optional(),
    output: z.unknown().optional(),
    columns: z.array(z.string()).optional(),
    defaultFormat: z.enum(["table", "json", "yaml", "csv", "md"]).optional(),
    stream: z.boolean().optional(),
  })
  .superRefine((command, ctx) => {
    if (!command.retrieval?.arguments) return;
    const declaredArguments = new Set(Object.keys(command.args ?? {}));
    for (const [role, target] of Object.entries(command.retrieval.arguments)) {
      if (declaredArguments.has(target)) continue;
      ctx.addIssue({
        code: "custom",
        path: ["retrieval", "arguments", role],
        message: `maps to undeclared adapter argument ${JSON.stringify(target)}`,
      });
    }
  });

export type AdapterCommandV2 = z.infer<typeof AdapterCommandV2Schema>;

/** Result of {@link validateAdapterV2}. */
export type AdapterValidationResult =
  | { ok: true; data: AdapterCommandV2 }
  | { ok: false; error: string };

/**
 * Strict parse — throws on invalid input. Use inside trusted boundaries
 * where we genuinely want a loud failure (e.g. CLI `unicli lint`).
 */
export function parseAdapterV2(input: unknown): AdapterCommandV2 {
  return AdapterCommandV2Schema.parse(input);
}

/**
 * Safe parse — returns a tagged union. Use inside adapter loaders where we
 * want to continue with a degraded result instead of aborting the run.
 */
export function validateAdapterV2(input: unknown): AdapterValidationResult {
  const result = AdapterCommandV2Schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: formatZodError(result.error) };
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Migrate a v1 AdapterCommand to v2. Fields already present are preserved;
 * missing required v2 fields get safe defaults:
 *
 *   capabilities       → []
 *   minimum_capability → "http.fetch"
 *   trust              → "public"
 *   confidentiality    → "public"
 *   quarantine         → false
 */
export function migrateToV2(input: unknown): AdapterCommandV2 {
  const src = (input ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...src,
    schema_version: "v2",
    capabilities: Array.isArray(src.capabilities) ? src.capabilities : [],
    minimum_capability:
      typeof src.minimum_capability === "string"
        ? src.minimum_capability
        : AdapterV2DefaultMinimumCapability,
    trust:
      typeof src.trust === "string" &&
      AdapterTrustSchema.safeParse(src.trust).success
        ? src.trust
        : "public",
    confidentiality:
      typeof src.confidentiality === "string" &&
      AdapterConfidentialitySchema.safeParse(src.confidentiality).success
        ? src.confidentiality
        : "public",
    quarantine: typeof src.quarantine === "boolean" ? src.quarantine : false,
  };
  return parseAdapterV2(merged);
}
