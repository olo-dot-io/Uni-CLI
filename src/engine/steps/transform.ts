/**
 * Transform step handlers: select, map, filter, sort, limit.
 *
 * Per-concern module extracted as part of the v0.212 engine restructure.
 * The implementations remain in `src/engine/yaml-runner.ts` (the legacy
 * orchestrator); this module is the stable import boundary that future
 * phases will migrate bodies into.
 */

export {
  stepSelect as handleSelect,
  stepMap as handleMap,
  stepFilter as handleFilter,
  stepSort as handleSort,
  stepLimit as handleLimit,
  type SortConfig,
} from "../yaml-runner.js";
