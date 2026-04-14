/**
 * Unified type exports for the v0.212 core layer.
 *
 * This module is the single entry point agents and adapters import to reach
 * the envelope, transport kinds, capability declaration, and the schema-v2
 * shape for AdapterCommand.
 *
 * Backward-compat: re-exports legacy `AdapterType`, `Strategy`, `IPage`,
 * `OutputFormat`, `ExitCode` from `src/types.ts` so existing imports keep
 * working while the migration is in-flight.
 */

// Re-export legacy types (Phase 1.1 is additive — no deletions).
export type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
  DownloadResult,
  IPage,
  NetworkRequest,
  OutputFormat,
  OutputSchema,
  PipelineErrorDetail,
  PipelineStep,
  ResolvedCommand,
  ScreenshotOptions,
  SnapshotOptions,
} from "../types.js";
export { AdapterType, ExitCode, Strategy } from "../types.js";

// New v0.212 core surface — transport ids + capability declaration.
export type { Capability, TransportKind } from "../transport/types.js";

export type {
  Envelope,
  EnvelopeError,
  EnvelopeErr,
  EnvelopeOk,
  EnvelopeMeta,
  EnvelopeExitCode,
  ErrInput,
} from "./envelope.js";
export { EnvelopeExit, err, exitCodeFor, ok } from "./envelope.js";

export type {
  AdapterCommandV2,
  AdapterTrust,
  AdapterConfidentiality,
  AdapterValidationResult,
} from "./schema-v2.js";
export {
  AdapterV2DefaultMinimumCapability,
  AdapterCommandV2Schema,
  migrateToV2,
  parseAdapterV2,
  validateAdapterV2,
} from "./schema-v2.js";

/**
 * `TransportId` is the stable string literal union identifying a transport.
 * Aliased here for callers that prefer the shorter name.
 */
export type { TransportKind as TransportId } from "../transport/types.js";
