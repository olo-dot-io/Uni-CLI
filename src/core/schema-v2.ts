/**
 * AdapterCommand schema v2 — runtime validation + v1 migration.
 *
 * Adds five required fields over v1:
 *   capabilities         — pipeline step names this command may invoke
 *   minimum_capability   — single step the dispatcher must support to run it
 *   trust                — provenance trust level (public | user | system)
 *   confidentiality      — data sensitivity label (public | internal | private)
 *   quarantine           — CI health gate flag; if true, command is skipped
 *                          until repaired
 *
 * Legacy v1 adapters (the 800+ YAML in `src/adapters/`) migrate via
 * {@link migrateToV2} which fills defaults without touching already-set fields.
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

/**
 * AdapterCommand v2 schema.
 *
 * Kept loose on the legacy fields (name, description, pipeline, ...) because
 * the v1 shape has historical leniency. The v2 layer is strictly validated
 * on the new fields — which is the point of the migration gate.
 */
export const AdapterCommandV2Schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // Optional on the parser so legacy v1 -> v2 migration paths can still
  // flow through parseAdapterV2 without a value. The schema-v2 lint
  // (scripts/lint-schema-v2.ts) enforces that every *committed* adapter
  // YAML carries the tag explicitly.
  schema_version: AdapterSchemaVersionSchema.optional(),
  capabilities: z.array(z.string()),
  minimum_capability: z.string().min(1),
  trust: AdapterTrustSchema,
  confidentiality: AdapterConfidentialitySchema,
  quarantine: z.boolean(),
  // Legacy shape fields carried through opaquely — zod.unknown keeps them
  // without forcing a schema for every historical key.
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
  output: z.unknown().optional(),
  columns: z.array(z.string()).optional(),
  defaultFormat: z.enum(["table", "json", "yaml", "csv", "md"]).optional(),
  stream: z.boolean().optional(),
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
