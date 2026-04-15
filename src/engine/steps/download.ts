/**
 * Download step handler (HTTP + yt-dlp + document save).
 *
 * Per-concern module extracted as part of the v0.212 engine restructure.
 * The implementation remains in `src/engine/yaml-runner.ts` (the legacy
 * orchestrator); this module is the stable import boundary that future
 * phases will migrate the body into.
 */

export {
  stepDownload as handleDownload,
  type DownloadStepConfig,
} from "../yaml-runner.js";
