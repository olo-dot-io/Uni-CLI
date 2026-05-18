/**
 * @owner       src::index
 * @does        Public TypeScript surface for third-party consumers of @zenalexa/unicli — re-exports the patent vertical types and the small set of normalizer helpers that are safe to call from outside the package.
 * @needs       src/types/patent.ts, src/engine/normalizer/patent-envelope.ts
 * @feeds       npm consumers via the `./index` subpath in package.json; tests/unit/public-surface/patent.test.ts
 * @breaks      none at runtime — type-only file with two runtime re-exports (canonicalizePublicationNumber, dedupeByFamily). Downstream consumers fail type-check on shape drift.
 * @invariants  this module re-exports only intentionally-public names; internal helpers (assemblePatentRecord, buildPatentEnvelope) stay un-exported here
 * @side-effects none
 * @perf        n/a (re-exports)
 * @concurrency safe (pure re-exports)
 * @test        tests/unit/public-surface/patent.test.ts
 * @stability   stable — semver-tracked public surface
 * @since       2026-05-18
 *
 * The CLI entry point lives in `./main.ts`; this file is the type-and-helper
 * surface for npm consumers building on top of unicli. Keep this file thin —
 * each export here is part of the package's public contract.
 */

// Public patent types — for third-party consumers building on top of unicli.
// Every name below is part of the patent vertical's stable contract; adapters
// outside this repo can depend on the shapes here without reaching into
// internal modules.
export type {
  PatentRecord,
  PatentCommand,
  PatentSearchQuery,
  PatentParty,
  PatentClassification,
  PatentFamilyMember,
  PatentEnvelope,
  PatentErrorCode,
  PatentVerificationStatus,
} from "./types/patent.js";

// Public helpers from the patent-envelope normalizer.
//
// canonicalizePublicationNumber — pure ST.16 segmentation; safe to call from
//   third-party adapters that produce PatentRecord values.
export { canonicalizePublicationNumber } from "./engine/normalizer/patent-envelope.js";

// dedupeByFamily — family-id-aware dedupe over a result list; useful when a
//   third-party caller fans out across multiple sources before yielding.
export { dedupeByFamily } from "./engine/normalizer/patent-envelope.js";

// extractKindCode — pull the ST.16 kind suffix (A1, A2, B1, …) off either a
//   segmented (`US-20240123456-A1`) or compact (`US20240123456A1`) publication
//   number. Returns `undefined` when the input cannot be parsed — callers
//   should not invent a kind value.
export { extractKindCode } from "./engine/normalizer/patent-envelope.js";

// Note: `assemblePatentRecord` and `buildPatentEnvelope` are intentionally
// internal-by-default. They stamp `retrieved_at` from system time and
// translate between error codes and exit codes — surfaces the package owns
// and may evolve. Third-party callers should construct PatentRecord literals
// directly and read `PatentErrorCode` / `PatentEnvelope` from the type
// exports above.
