/**
 * Desktop / subprocess step handlers: exec, write_temp.
 *
 * Per-concern module extracted as part of the v0.212 engine restructure.
 * The implementations remain in `src/engine/yaml-runner.ts` (the legacy
 * orchestrator); this module is the stable import boundary that future
 * phases will migrate bodies into.
 */

export {
  stepExec as handleExec,
  stepWriteTemp as handleWriteTemp,
  type ExecConfig,
  type WriteTempConfig,
} from "../yaml-runner.js";
