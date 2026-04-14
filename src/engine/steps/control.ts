/**
 * Control-flow step handlers: set, if, append, each, parallel, assert.
 *
 * Per-concern module extracted as part of the v0.212 engine restructure.
 * The implementations remain in `src/engine/yaml-runner.ts` (the legacy
 * orchestrator); this module is the stable import boundary that future
 * phases will migrate bodies into.
 */

export {
  stepSet as handleSet,
  stepAppend as handleAppend,
  stepIf as handleIf,
  stepEach as handleEach,
  stepParallel as handleParallel,
  stepAssert as handleAssert,
  type AssertConfig,
  type EachConfig,
} from "../yaml-runner.js";
