/**
 * Barrel export for the v0.212 core layer.
 *
 * Prefer importing from `@zenalexa/unicli/core` (or the relative
 * path `src/core/index.js`) so adapter authors get a single stable
 * surface.
 */

export * from "./types.js";
export * from "./envelope.js";
export * from "./schema-v2.js";
export {
  cli,
  getCommandMetadataV2,
  listCommandMetadataV2,
  registerAdapter,
  resolveCommand,
  getAdapter,
  getAllAdapters,
  listCommands,
  __resetCommandMetadataV2,
  type CliRegistration,
  type CliRegistrationV2,
  type CommandMetadataV2,
} from "./registry.js";
