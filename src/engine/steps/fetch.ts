/**
 * Fetch / RSS / HTML → Markdown step handlers.
 *
 * Per-concern module extracted as part of the v0.212 engine restructure.
 * The implementations remain in `src/engine/yaml-runner.ts` (the legacy
 * orchestrator); this module is the stable import boundary that future
 * phases will migrate bodies into.
 */

export {
  stepFetch as handleFetch,
  stepFetchText as handleFetchText,
  stepParseRss as handleParseRss,
  stepHtmlToMd as handleHtmlToMd,
  type FetchConfig,
  type RssConfig,
} from "../yaml-runner.js";
